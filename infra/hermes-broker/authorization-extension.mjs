/** Shared step for the capability adapters layered over the durable CRM Auth
 * adapter. The base authorization and the adapter's own capability RPC are
 * independent reads with the same caller JWT/org, so both start in one network
 * wave instead of one after the other. Precedence is unchanged: a base failure
 * wins, then the caller's validation of the base result, and only then a
 * capability failure (`capability()` throws it). A base failure is returned at
 * once; the caller's abort signal then cancels the capability read, whose own
 * transport stays tracked by the dependency scope. No result is cached.
 */
export async function readWithBaseAuthorization(baseAuth, input, readCapability) {
  const extension = Promise.resolve().then(() => readCapability())
    .then(value => ({ ok: true, value }), reason => ({ ok: false, reason }));
  const current = await Promise.resolve().then(() => baseAuth.readAuthorization(input));
  const settled = await extension;
  return Object.freeze({ current, capability() {
    if (!settled.ok) throw settled.reason;
    return settled.value;
  } });
}
