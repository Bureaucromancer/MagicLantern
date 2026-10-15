// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * The request rules a schema can't state with field-level errors (A4, A7, A9).
 * Run after schema validation: a request is valid when it passes both.
 *
 * Each issue's `path` is a JSON pointer (RFC 6901) to the field at fault, the
 * same form the daemon's 422 `issues` use, so the two lists concatenate. A
 * missing required input points at `/inputs`, a missing field at the field.
 */

import type { ValidationIssue } from '../api/errors.js';
import {
  type GenerationMode,
  type GenerationRequest,
  type InputRole,
  PASS_SCHEMAS,
  type SourceRect,
} from './generation-request.js';

/**
 * The input roles each mode requires, one of each at least (A4). Upscale also
 * needs a scale, which comes from an `upscale` pass.
 */
export const MODE_REQUIRED_INPUTS: Readonly<Record<GenerationMode, readonly InputRole[]>> = {
  txt2img: [],
  img2img: ['init'],
  inpaint: ['init', 'mask'],
  edit: ['ref'],
  txt2vid: [],
  img2vid: [],
  vid_extend: [],
  upscale: ['init'],
};

/** Roles a request may give at most once: a generation has one init image and one mask. */
export const SINGLE_INPUT_ROLES: readonly InputRole[] = ['init', 'mask'];

/** Roles that take no `weight`: init strength is `sampling.denoise`, never an input weight (A8). */
export const UNWEIGHTED_INPUT_ROLES: readonly InputRole[] = ['init', 'mask'];

/**
 * Slack for `x + width ≤ 1`, because normalised coordinates are decimals that
 * binary floating point can't hold exactly: a rectangle that ends at the edge
 * must not be refused for a sum of 1.0000000000000002.
 */
export const SOURCE_RECT_TOLERANCE = 1e-9;

/**
 * The checks on a {@link SourceRect} that its schema leaves to code: it has an
 * area, and it stays inside the image.
 *
 * @param rect a rectangle that passed the schema
 * @param path the JSON pointer to the rectangle
 */
export function checkSourceRect(rect: SourceRect, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const axes = [
    ['width', rect.x, rect.width, 'x'],
    ['height', rect.y, rect.height, 'y'],
  ] as const;
  for (const [name, start, extent, origin] of axes) {
    if (extent <= 0) {
      issues.push({ path: `${path}/${name}`, message: 'must be greater than 0' });
    } else if (start + extent > 1 + SOURCE_RECT_TOLERANCE) {
      issues.push({ path: `${path}/${name}`, message: `must be at most 1 − ${origin}` });
    }
  }
  return issues;
}

function checkInputs(request: GenerationRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const inputs = request.inputs ?? [];
  const seen = new Set<InputRole>();

  inputs.forEach((input, i) => {
    const at = `/inputs/${String(i)}`;
    if (SINGLE_INPUT_ROLES.includes(input.role) && seen.has(input.role)) {
      issues.push({ path: `${at}/role`, message: `only one \`${input.role}\` input is allowed` });
    }
    seen.add(input.role);
    if (input.weight !== undefined && UNWEIGHTED_INPUT_ROLES.includes(input.role)) {
      issues.push({
        path: `${at}/weight`,
        message: `\`${input.role}\` inputs take no weight; img2img strength is \`sampling.denoise\``,
      });
    }
    if (input.region !== undefined) issues.push(...checkSourceRect(input.region, `${at}/region`));
    if (input.crop !== undefined) issues.push(...checkSourceRect(input.crop, `${at}/crop`));
  });

  for (const role of MODE_REQUIRED_INPUTS[request.mode]) {
    if (!seen.has(role)) {
      issues.push({ path: '/inputs', message: `${request.mode} needs a \`${role}\` input` });
    }
  }
  return issues;
}

function checkPasses(request: GenerationRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const passes = request.passes ?? [];

  passes.forEach((pass, i) => {
    const at = `/passes/${String(i)}`;
    const schema = PASS_SCHEMAS[pass.kind];
    const fields = Object.keys(pass);
    for (const field of fields) {
      if (!(field in schema.properties)) {
        issues.push({
          path: `${at}/${field}`,
          message: `is not a field of a \`${pass.kind}\` pass`,
        });
      }
    }
    for (const field of schema.required) {
      if (!fields.includes(field)) issues.push({ path: `${at}/${field}`, message: 'is required' });
    }
    if (pass.kind === 'hires') {
      if (pass.scale === undefined && pass.target === undefined) {
        issues.push({ path: `${at}/scale`, message: 'a hires pass needs `scale` or `target`' });
      } else if (pass.scale !== undefined && pass.target !== undefined) {
        issues.push({ path: `${at}/target`, message: 'give `scale` or `target`, not both' });
      }
    }
  });

  if (request.mode === 'upscale' && !passes.some((pass) => pass.kind === 'upscale')) {
    issues.push({
      path: '/passes',
      message: 'upscale needs an `upscale` pass, which gives the scale',
    });
  }
  return issues;
}

function checkExperimental(request: GenerationRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  request.subjects?.forEach((subject, s) => {
    subject.references.forEach((reference, r) => {
      if (reference.crop === undefined) return;
      issues.push(
        ...checkSourceRect(reference.crop, `/subjects/${String(s)}/references/${String(r)}/crop`),
      );
    });
  });
  request.style?.exemplars.forEach((exemplar, e) => {
    if (exemplar.crop === undefined) return;
    issues.push(...checkSourceRect(exemplar.crop, `/style/exemplars/${String(e)}/crop`));
  });
  return issues;
}

/**
 * Every rule the {@link GenerationRequest} schema leaves to code:
 * - each mode's required inputs (img2img: `init`; inpaint: `init` and `mask`;
 *   edit: at least one `ref`; upscale: `init` and an `upscale` pass);
 * - at most one `init` and one `mask`, neither with a `weight`;
 * - every crop and region has an area and stays inside the image;
 * - each pass holds only its kind's fields, and a hires pass gives exactly
 *   one of `scale` and `target`.
 *
 * Nothing is rewritten: the request is only read.
 *
 * @param request a request that passed schema validation
 * @returns the issues, empty when the request is valid
 */
export function checkGenerationRequest(request: GenerationRequest): ValidationIssue[] {
  return [...checkInputs(request), ...checkPasses(request), ...checkExperimental(request)];
}
