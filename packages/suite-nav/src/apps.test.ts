import { describe, it, expect } from 'vitest';
import type { SuiteApp } from './apps.js';
import { suiteApps, getSuiteApp, otherSuiteApps } from './apps.js';

describe('suiteApps', () => {
  it('has unique ids for every entry', () => {
    const ids = suiteApps.map((app: SuiteApp) => app.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a url starting with https:// for every entry', () => {
    for (const app of suiteApps) {
      expect(app.url.startsWith('https://')).toBe(true);
    }
  });

  it('has non-empty name, description, and accentColor for every entry', () => {
    for (const app of suiteApps) {
      expect(app.name.length).toBeGreaterThan(0);
      expect(app.description.length).toBeGreaterThan(0);
      expect(app.accentColor.length).toBeGreaterThan(0);
    }
  });
});

describe('getSuiteApp', () => {
  it('returns the matching entry for a known id', () => {
    expect(getSuiteApp('chorus')).toEqual(suiteApps.find((app) => app.id === 'chorus'));
  });

  it('returns undefined for an unknown id', () => {
    expect(getSuiteApp('nonexistent')).toBeUndefined();
  });
});

describe('otherSuiteApps', () => {
  it('excludes the given id and has length suiteApps.length - 1', () => {
    const others = otherSuiteApps('chorus');
    expect(others.some((app) => app.id === 'chorus')).toBe(false);
    expect(others.length).toBe(suiteApps.length - 1);
  });
});
