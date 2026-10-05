import { describe, expect, it } from 'vitest';
import { resolveLoginRedirect, safeAuthRedirect } from '../authRedirect';

describe('safe post-login destinations', () => {
  it.each([
    [undefined, null], [null, null], [false, null], [{ pathname: '/' }, null],
    ['', null], ['finance/personal-wallet', null], ['https://evil.example/', null],
    ['javascript:alert(1)', null], ['//evil.example', null], ['/\\evil.example', null],
    ['/\tevil.example', null], ['/\nevil.example', null], ['/evil\r.example', null],
    ['/\u0000evil', null], ['/\u007fevil', null], ['/ %2Fevil', null],
    ['/%2fevil.example', null], ['/%5Cevil.example', null], ['/%252fevil.example', null],
    ['/%0aevil', null], ['/%1fevil', null], ['/%7fevil', null], ['/%', null],
    ['/login?next=/finance/personal-wallet', null], ['/LOGIN/', null], ['/register', null],
    ['/forgot-password', null], ['/reset-password#token', null], ['/%6cogin', null],
    ['/finance/../login', null], ['/finance/%2e%2e/login', null],
    ['/', '/'], ['/finance/personal-wallet?month=2026-10#transactions', '/finance/personal-wallet?month=2026-10#transactions'],
    ['/finance/personal-wallet?q=c%C3%A0%20ph%C3%AA#new', '/finance/personal-wallet?q=c%C3%A0%20ph%C3%AA#new'],
    ['/finance/personal-wallet?discount=10%25#summary', '/finance/personal-wallet?discount=10%25#summary'],
  ])('validates %j → %j', (input, expected) => {
    expect(safeAuthRedirect(input)).toBe(expected);
  });

  it('gives explicit next priority over stale state and keeps it through URL recreation', () => {
    expect(resolveLoginRedirect('?next=%2Finvoices%3Fmonth%3D10%23due', { from: { pathname: '/customers' } })).toBe('/invoices?month=10#due');
    expect(resolveLoginRedirect('?next=%2Finvoices%3Fmonth%3D10%23due')).toBe('/invoices?month=10#due');
    expect(resolveLoginRedirect('?next=', { from: { pathname: '/customers' } })).toBe('/');
  });

  it.each([null, 'stale', {}, { from: '//evil.example' }, { from: null }, { from: { pathname: '//evil.example' } }, { from: { pathname: '/invoices', search: '/bad' } }, { from: { pathname: '/invoices', hash: 1 } }, { from: { pathname: '/login' } }])('fails closed for malformed legacy state: %j', state => {
    expect(resolveLoginRedirect('', state)).toBe('/');
  });
});
