# Changelog

## v0.2.1 - 2026-05-30

### Fixed
- Made Tavily API key lookup independent of Pi's current working directory by supporting `PI_TAVILY_ENV_FILE` and `~/.pi/agent/state/pi-tavily/config.json` `envFile`.
- Replaced the misleading missing-key error with a visibility/scope diagnostic that does not print secrets.

## v0.2.0 - 2026-05-27

### Removed
- Removed the non-orthogonal `tavily_search_extract` convenience tool. Use `tavily_search` to find URLs and `tavily_extract` to read selected public URLs.

## v0.1.0 - 2026-05-26

### Added
- Initial Pi extension package with Tavily-backed `tavily_search`, `tavily_extract`, and `tavily_search_extract` tools.
