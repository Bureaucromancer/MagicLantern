// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Magic Lantern contributors

/** The `lemonade` manager kind (SD6): sd-server children discovered through Lemonade's health. */

export {
  childBaseUrl,
  isLemonadeHealth,
  LEMONADE_ADAPTER,
  LEMONADE_DEFAULT_SETTINGS,
  LEMONADE_HEALTH_PATH,
  LEMONADE_SECRETS_SCHEMA,
  LEMONADE_SETTINGS_SCHEMA,
  LemonadeManager,
  readLemonadeSettings,
  routesFromHealth,
  SDCPP_RECIPE,
  type LemonadeManagerOptions,
  type LemonadeSettings,
} from './lemonade.js';
