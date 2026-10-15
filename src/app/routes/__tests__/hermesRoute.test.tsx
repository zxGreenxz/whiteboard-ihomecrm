import { isValidElement, type ReactElement } from 'react';
import { createRoutesFromChildren } from 'react-router-dom';
import { expect, it } from 'vitest';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import { HermesConnectionsPage } from '@/app/lazyPages';
import { settingsRoutes } from '../settingsRoutes';

it('exposes the self-service Hermes page lazily behind authentication, without an unrelated admin permission gate', () => {
  const found = createRoutesFromChildren(settingsRoutes).filter(route => route.path === '/settings/hermes');
  expect(found).toHaveLength(1);
  const element = found[0].element;
  expect(isValidElement(element)).toBe(true);
  const protectedElement = element as ReactElement<{ children: ReactElement }>;
  expect(protectedElement.type).toBe(ProtectedRoute);
  expect(protectedElement.props.children.type).toBe(HermesConnectionsPage);
});
