import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ALL_PAGES } from '@/lib/permissionPages';
import { ERROR_PAGE_NAMES, errorPageName } from '@/lib/errorPageNames';

function canonicalPageName(path: string): string {
  return [...ALL_PAGES]
    .sort((a, b) => b.route.length - a.route.length)
    .find(page => path === page.route || (page.route !== '/' && path.startsWith(`${page.route}/`)))?.label ?? 'đang mở';
}

describe('error page labels without the permission catalog at boot', () => {
  it('keeps every canonical route and label in the exact catalog order', () => {
    expect(ERROR_PAGE_NAMES).toEqual(ALL_PAGES.map(({ route, label }) => ({ route, label })));
  });

  it('keeps canonical lookup results for every route and descendant', () => {
    for (const page of ALL_PAGES) {
      for (const path of [page.route, `${page.route === '/' ? '' : page.route}/notification-feedback-child/nested`]) {
        expect(errorPageName(path), path).toBe(canonicalPageName(path));
      }
    }
  });

  it('keeps the first catalog label when routes have equal length and the same path', () => {
    expect(errorPageName('/')).toBe('Bảng tin');
  });

  it('keeps unknown and empty paths separate from similarly named routes', () => {
    for (const path of ['', '/unknown-notification-page', '/contracts-other', '/settings/categories-other']) {
      expect(errorPageName(path), path).toBe('đang mở');
    }
  });

  it('has no runtime imports that could pull the auth catalog back into boot', () => {
    const source = ts.createSourceFile('errorPageNames.ts', readFileSync('src/lib/errorPageNames.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(source.statements.filter(ts.isImportDeclaration)).toEqual([]);
  });
});
