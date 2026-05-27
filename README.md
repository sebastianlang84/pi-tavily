# pi-tavily

Pi Coding Agent extension package that registers Tavily-backed web tools:

- `tavily_search` — search the public web and return compact cited results.
- `tavily_extract` — extract readable content from public HTTP(S) URLs.

## Install

Local development install:

```bash
pi install /home/wasti/.pi/agent/git/github.com/sebastianlang84/pi-tavily
```

Git install after the repo is pushed:

```bash
pi install git:github.com/sebastianlang84/pi-tavily
```

Reload Pi after install:

```text
/reload
```

## Configuration

Set `TAVILY_API_KEY` in the environment. The extension also supports a local development fallback from a Git repo root `.env` only when that `.env` is both untracked and gitignored.

Do not commit Tavily API keys or `.env` files.

## Development

Run the offline harness; it mocks `fetch` and does not call Tavily:

```bash
npm test
```

The harness loads Pi from the global npm install. If Pi is not globally discoverable on your machine, set `PI_CODING_AGENT_ROOT` to the local `@earendil-works/pi-coding-agent` package directory before running tests.

Additional checks:

```bash
npm run check
PI_OFFLINE=1 pi --no-extensions -e ./src/index.ts --list-models no-such-model-filter
```
