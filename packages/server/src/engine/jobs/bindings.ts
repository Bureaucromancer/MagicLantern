// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/**
 * Which adapter serves each route, and the resource group it runs in (A12).
 *
 * A seam like the model catalog: the backend registry (engine/backends)
 * builds it from the install database's `backends` and `routes`; tests give
 * a list ({@link StaticBindings}).
 *
 * One slot per resource group, keyed by GPU host and defaulting to the
 * backend, so a standalone sd-server and a Lemonade on the same box share
 * one: Lantern never submits more than a group can run, which keeps the
 * backend's own queue empty and Lantern's order the real one.
 */

import type { Adapter } from '../../adapters/shared/index.js';

export interface RouteBinding {
  readonly routeId: string;
  readonly backendId: string;
  /** The kind of the adapter that serves the route (`sdcpp`), whichever backend found it. */
  readonly backendKind: string;
  /** The manager that discovered the route (L1), and its own name for the model. */
  readonly manager?: { readonly kind: string; readonly ref: string };
  /** The backend's base URL, as its handles' instance fingerprints carry it. */
  readonly baseUrl: string;
  readonly adapter: Adapter;
  /** Defaults to the backend id. */
  readonly resourceGroup: string;
  /** How many jobs the group runs at once; 1 for a GPU. */
  readonly concurrency: number;
}

export interface BackendBindings {
  binding(routeId: string): RouteBinding | undefined;
  /** The concurrency of a group: the smallest any of its routes declares. */
  concurrency(group: string): number;
  all(): readonly RouteBinding[];
}

export class StaticBindings implements BackendBindings {
  private readonly byRoute: ReadonlyMap<string, RouteBinding>;

  constructor(bindings: readonly RouteBinding[]) {
    const byRoute = new Map<string, RouteBinding>();
    for (const binding of bindings) {
      if (byRoute.has(binding.routeId)) throw new Error(`Route ${binding.routeId} is bound twice.`);
      byRoute.set(binding.routeId, binding);
    }
    this.byRoute = byRoute;
  }

  binding(routeId: string): RouteBinding | undefined {
    return this.byRoute.get(routeId);
  }

  concurrency(group: string): number {
    let least = Number.POSITIVE_INFINITY;
    for (const binding of this.byRoute.values()) {
      if (binding.resourceGroup === group) least = Math.min(least, binding.concurrency);
    }
    return Number.isFinite(least) ? Math.max(1, least) : 1;
  }

  all(): readonly RouteBinding[] {
    return [...this.byRoute.values()];
  }
}
