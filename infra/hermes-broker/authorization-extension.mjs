/** Shared step for the capability adapters layered over the durable CRM Auth
 * adapter. The base authorization and the adapter's own capability RPC are
 * independent reads with the same caller JWT/org, so both start in one network
 * wave instead of one after the other. Precedence is unchanged: a base failure
 * wins, then the caller's validation of the base result, and only then a
 * capability failure (`capability()` throws it). Both reads always settle, so a
 * dependency scope never loses track of the second one. No result is cached.
 */
export async function readWithBaseAuthorization(baseAuth, input, readCapability) {
  const [base, extension] = await Promise.allSettled([
    Promise.resolve().then(() => baseAuth.readAuthorization(input)),
    Promise.resolve().then(() => readCapability()),
  ]);
  if (base.status === 'rejected') throw base.reason;
  return Object.freeze({ current: base.value, capability() {
    if (extension.status === 'rejected') throw extension.reason;
    return extension.value;
  } });
}
