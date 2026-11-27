# Caudal Web

Caudal's original React workspace uses the Aspect UI v0.2.0 registry controls for buttons, text fields, badges and dialogs. The source subset is under `src/aspect/`. Caudal-specific screens, navigation and color profile live in `src/`.

```sh
npm ci
npm run check
npm test
npm run build
```

Use `npm run dev` to proxy same-origin API calls to the local Go server at `127.0.0.1:8080`. Vite builds the files into `dist/`.

The Chromium suite uses a synthetic, isolated API fixture. It exercises login, enrollment, history, assistant evidence, opt-in key entry and responsive navigation. The production build starts with data from the server.

```sh
npx playwright install chromium
npm run test:e2e
```

The installable app uses a service worker for an offline navigation message. The browser does not persist fleet snapshots, conversation turns or the DeepSeek key. Caudal uses an HTTP-only cookie for browser session state.
