import eslint from '@eslint/js';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'playwright-report', 'test-results'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['src/**/*.tsx'], plugins: { 'react-hooks': hooks }, rules: hooks.configs.recommended.rules },
  { files: ['public/service-worker.js'], languageOptions: { globals: globals.serviceworker } },
);
