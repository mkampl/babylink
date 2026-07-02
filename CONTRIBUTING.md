# Contributing

## Running the project

```sh
npm install
npm start          # server on http://localhost:3001
npm test           # vitest suite
npm run dev        # nodemon watch mode (if configured)
```

For local HTTPS (required to test `getUserMedia` on a LAN IP):

```sh
caddy run --config Caddyfile.local
```

## Branch and PR conventions

- Branch off `main`. Name branches `feat/<topic>`, `fix/<topic>`, or
  `chore/<topic>`.
- Keep commits small and focused. Use conventional commit prefixes
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- Open a pull request against `main`. Fill in the PR template.
- **Tests must stay green.** Run `npm test` before pushing. The CI
  check will fail if tests regress.

## Code style

- Vanilla JS and CSS — no framework, no transpiler, no bundler.
- Server: Node.js / Express / Socket.IO. Keep it readable without a
  build step.
- Linting is not yet enforced by CI, but follow the existing style
  (2-space indent, single quotes, no semicolons where the project
  omits them).

## Firmware

The ESP32-S3 firmware lives in `esp32-s3-firmware-idf/` and is built
with ESP-IDF via the Docker wrapper (`./idf.sh build`). Firmware
changes require a connected XIAO ESP32-S3 Sense to validate. See
`esp32-s3-firmware-idf/README.md` for build and flash instructions.

Do not submit firmware changes that have not been flashed and verified
on hardware.

## Scope

BabyLink is **audio-only**. Video is intentionally out of scope.
PRs that add video capture or streaming will not be merged.
