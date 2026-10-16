/**
 * Implementation-prompt guidance shared by every task tracker (DEV-154).
 *
 * External data is untyped until it is parsed, so agents are told to convert it
 * into a named domain type at the point it enters the code. Kept in one place
 * so {@link TaskFormatter} and the markdown tracker cannot drift apart.
 */
export const PARSE_AT_BOUNDARY_GUIDANCE =
  "**Parse at the boundary**: External data is untyped until you parse it — tracker/API payloads, JSON and HTTP responses, config files, environment variables, CLI arguments, and database rows. Convert it into a named domain type exactly where it enters the code (the boundary), using the project's existing schema/validation library when one exists, and trust that type inward. Do not let raw `any`/`unknown` flow past the boundary, and only use `as` casts after the value has been validated.";
