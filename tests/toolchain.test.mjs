import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Exercise the actual Expo -> config-plugins -> xcode dependency chain.
// This guards the narrow uuid major-version security override.
test('Expo xcode tooling remains compatible with patched uuid', () => {
  const mobileRequire = createRequire(
    new URL('../apps/student-mobile/package.json', import.meta.url),
  );
  const expoRequire = createRequire(mobileRequire.resolve('expo/package.json'));
  const pluginsRequire = createRequire(expoRequire.resolve('@expo/config-plugins/package.json'));
  const xcodeRequire = createRequire(pluginsRequire.resolve('xcode/package.json'));
  assert.equal(xcodeRequire('uuid/package.json').version, '11.1.1');
  const project = pluginsRequire('xcode').project('in-memory.pbxproj');
  project.hash = { project: { objects: {} } };
  const first = project.generateUuid();
  const second = project.generateUuid();
  assert.match(first, /^[A-F0-9]{24}$/);
  assert.match(second, /^[A-F0-9]{24}$/);
  assert.notEqual(first, second);
});
