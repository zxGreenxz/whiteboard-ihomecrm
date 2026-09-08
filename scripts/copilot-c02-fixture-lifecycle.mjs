/** Bounded C02 DEMO fixture. No environment, vault, global fetch, or live entry point. */
import { randomUUID, createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DEMO_ORG, digest } from './copilot-golden-browser-evidence.mjs';
export const C02_HOST = '10b1a785-6344-4598-812c-6dc6e98837ed';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const requireState = (ok, reason) => { if (!ok)
    throw new Error(reason); };
const copy = value => structuredClone(value);
const ordered = rows => [...rows].sort((a, b) => a.id.localeCompare(b.id));
// Legacy host designation hashes raw text for actor and wrapped SQL rows for associations.
export const rawSha256 = value => createHash('sha256').update(value).digest('hex');
export function designationAssociationDigest(rows) { return rawSha256(JSON.stringify(ordered(rows).map(row => ({ row })))); }
export function createC02FixturePlan({ contextId, actorId, customerId = randomUUID(), associationId = randomUUID() }) {
    requireState(typeof contextId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(contextId) && [actorId, customerId, associationId].every(v => typeof v === 'string' && UUID.test(v)) && new Set([actorId, customerId, associationId, C02_HOST]).size === 4, 'invalid_plan');
    const phone = `000${String(parseInt(digest(contextId).slice(0, 12), 16) % 10000000).padStart(7, '0')}`;
    return Object.freeze({ contextId, actorId, customerId, associationId, hostId: C02_HOST, organizationId: DEMO_ORG, phone, marker: `COPILOT_C02_${contextId}_${customerId}` });
}
function validatePlan(plan) { requireState(digest(plan) === digest(createC02FixturePlan(plan)), 'invalid_plan'); }
export function customerInsert(plan) { validatePlan(plan); return { id: plan.customerId, organization_id: DEMO_ORG, user_id: plan.actorId, full_name: 'Nguyễn An', phone: plan.phone, customer_type: 'INDIVIDUAL', status_v2: 'RENTING', notes: plan.marker }; }
export function associationInsert(plan) { validatePlan(plan); return { id: plan.associationId, organization_id: DEMO_ORG, contract_id: C02_HOST, customer_id: plan.customerId, is_representative: false, notes: plan.marker }; }
function owned(row, expected) { return row && Object.entries(expected).every(([key, value]) => row[key] === value); }
function uniqueOwned(rows, expected) { requireState(Array.isArray(rows) && rows.length <= 1, 'ownership_mismatch'); if (rows.length)
    requireState(owned(rows[0], expected), 'ownership_mismatch'); return rows[0]; }
function validatePreflight(plan, p, now = Date.now()) {
    const r = p?.review;
    requireState(p && Number.isFinite(Date.parse(p.measuredAt)) && now - Date.parse(p.measuredAt) >= 0 && now - Date.parse(p.measuredAt) <= 300000, 'preflight_stale');
    requireState(p.actorId === plan.actorId && p.organizationId === DEMO_ORG && p.actorCanReadHost === true && r?.hostId === C02_HOST && r.actorDigest === digest(plan.actorId), 'preflight_identity');
    requireState(p.host?.id === C02_HOST && p.host.organization_id === DEMO_ORG && p.host.status === 'TERMINATED' && p.host.deleted_at === null && UUID.test(p.host.room_id) && UUID.test(p.host.building_id), 'preflight_host');
    requireState(Array.isArray(p.associations) && p.associations.every(a => UUID.test(a.id)) && new Set(p.associations.map(a => a.id)).size === p.associations.length && digest(p.associations) === digest(ordered(p.associations)) && digest(p.host) === r.hostDigest && digest(p.associations) === r.associationsDigest, 'preflight_snapshot');
    requireState(['customers.view', 'customers.create', 'contracts.create', 'contracts.delete'].every(k => p.permissions?.[k] === true) && p.authenticatedExecute === true && p.anonExecute === false, 'preflight_permission');
    requireState(['exactNameMatches', 'phoneMatches', 'markerMatches', 'customerIdMatches', 'associationIdMatches'].every(k => p[k] === 0), 'preflight_collision');
    requireState(/^[a-f0-9]{40}$/.test(r.implementationSha) && ['triggerDigest', 'cleanupBodyDigest'].every(k => HASH.test(r[k]) && p[k] === r[k]), 'preflight_body');
    requireState(r.designationAssociationDigest === designationAssociationDigest(p.associations), 'preflight_designation');
    requireState(r.designationActorDigest === rawSha256(plan.actorId), 'preflight_designation');
}
/** Every writer must share this external directory. No automatic stale-lock takeover.
 * Operator recovery requires quarantining a dead owner's lock, retaining journal.json,
 * then acquireRecovery with the SAME plan. This API never removes a foreign lock. */
export function createC02FileStore({ directory }) {
    mkdirSync(directory, { recursive: true });
    const lockPath = join(directory, 'lock.json'), journalPath = join(directory, 'journal.json');
    let token;
    const load = () => existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
    const assertOwner = () => requireState(token && JSON.parse(readFileSync(lockPath, 'utf8')).token === token, 'lock_ownership');
    function acquire(recovery = false) {
        requireState(!token, 'lock_already_owned');
        const old = load();
        requireState(recovery ? old && old.state !== 'finalized' : !old || old.state === 'finalized', 'pending_journal');
        const nextToken = randomUUID();
        const fd = openSync(lockPath, 'wx');
        try {
            writeFileSync(fd, JSON.stringify({ token: nextToken, pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }));
            fsyncSync(fd);
            token = nextToken;
        }
        finally {
            closeSync(fd);
        }
        // Keep completed journals: a new lifecycle may never overwrite the old audit trail.
        if (!recovery && old)
            renameSync(journalPath, join(directory, `journal-${old.customerId}.json`));
    }
    return { acquire: () => acquire(), acquireRecovery: () => acquire(true), assertOwner, load,
        save(journal) { assertOwner(); const tmp = join(directory, `journal-${token}.tmp`); const fd = openSync(tmp, 'w'); try {
            writeFileSync(fd, JSON.stringify(journal, null, 2));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        } assertOwner(); renameSync(tmp, journalPath); },
        release() { assertOwner(); requireState(load()?.state === 'finalized', 'pending_journal'); unlinkSync(lockPath); token = undefined; },
    };
}
/** root supplies authenticated credentials and SELECT transport; no credential discovery.
 * readPreflight(plan) must independently refresh actor, permissions, collision and catalog proofs.
 * readonlySql receives ONLY fixed SELECT statements and returns unwrapped rows. */
export function createC02AppClient({ apiOrigin, credentialProvider, fetch, readonlySql, readPreflight }) {
    const origin = new URL(apiOrigin);
    requireState(origin.protocol === 'https:' && origin.origin === apiOrigin, 'invalid_api_origin');
    requireState([credentialProvider, fetch, readonlySql, readPreflight].every(f => typeof f === 'function'), 'missing_dependency');
    async function request(path, method, body, actorId) {
        const c = await credentialProvider();
        requireState(c && Object.keys(c).length === 3 && ['apikey', 'accessToken', 'actorId'].every(k => Object.hasOwn(c, k)) && c.actorId === actorId && typeof c.accessToken === 'string' && c.accessToken.trim() && typeof c.apikey === 'string' && c.apikey.trim(), 'credential_identity');
        const response = await fetch(`${apiOrigin}${path}`, { method, redirect: 'error', headers: { Authorization: `Bearer ${c.accessToken}`, apikey: c.apikey, 'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public', Prefer: 'return=representation' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        // HTTP status alone cannot prove rollback (including a proxy's 408/429).
        // The operator must reconcile the preallocated UUID; never retain error text.
        if (!response.ok)
            return { outcome: 'ambiguous' };
        return { outcome: 'success', value: await response.json() };
    }
    const literal = value => { requireState(typeof value === 'string' && UUID.test(value), 'invalid_read_id'); return `'${value}'::uuid`; };
    return {
        readPreflight,
        async createCustomer(body, plan) { validatePlan(plan); requireState(owned(body, customerInsert(plan)) && Object.keys(body).length === 8, 'invalid_customer_request'); return request('/rest/v1/customers?select=*', 'POST', body, plan.actorId); },
        // Lifecycle passes the plan as second argument so client can verify actor and every field.
        async createAssociation(body, plan) { validatePlan(plan); requireState(owned(body, associationInsert(plan)) && Object.keys(body).length === 6, 'invalid_association_request'); return request('/rest/v1/contract_customers?select=*', 'POST', body, plan.actorId); },
        async deleteAssociation(plan) { const params = new URLSearchParams(Object.entries(associationInsert(plan)).map(([k, v]) => [k, `eq.${v}`])); params.set('select', '*'); return request(`/rest/v1/contract_customers?${params}`, 'DELETE', undefined, plan.actorId); },
        async softDeleteCustomer(plan) { validatePlan(plan); return request('/rest/v1/rpc/soft_delete_customer', 'POST', { p_customer_id: plan.customerId }, plan.actorId); },
        readCustomers: plan => readonlySql(`SELECT * FROM public.customers WHERE id = ${literal(plan.customerId)}`),
        readAssociations: plan => readonlySql(`SELECT * FROM public.contract_customers WHERE id = ${literal(plan.associationId)} OR (contract_id = ${literal(plan.hostId)} AND customer_id = ${literal(plan.customerId)}) ORDER BY id`),
        async readSnapshot(plan) { const host = await readonlySql(`SELECT c.*, r.building_id FROM public.contracts c JOIN public.rooms r ON r.id = c.room_id WHERE c.id = ${literal(plan.hostId)}`); requireState(host.length === 1, 'host_readback'); return { host: host[0], associations: await readonlySql(`SELECT * FROM public.contract_customers WHERE contract_id = ${literal(plan.hostId)} ORDER BY id`) }; },
        async search(plan) { validatePlan(plan); const result = await request('/rest/v1/rpc/copilot_customer_search_v1', 'POST', { p_organization_id: DEMO_ORG, p_search: 'Nguyễn An' }, plan.actorId); requireState(result.outcome === 'success', 'search_failed'); return result.value; },
    };
}
export async function openC02Lifecycle({ plan, preflight, client, store, recovery = false }) {
    validatePlan(plan);
    let journal;
    if (recovery) {
        store.acquireRecovery();
        journal = store.load();
        requireState(journal.planDigest === digest(plan), 'recovery_plan_mismatch');
    }
    else {
        validatePreflight(plan, preflight);
        store.acquire();
        journal = { version: 1, state: 'preflight', customerId: plan.customerId, associationId: plan.associationId, actorId: plan.actorId, organizationId: DEMO_ORG, hostId: C02_HOST, contextDigest: digest(plan.contextId), actorDigest: digest(plan.actorId), planDigest: digest(plan), phoneDigest: digest(plan.phone), markerDigest: digest(plan.marker), hostDigest: digest(preflight.host), associationsDigest: digest(preflight.associations), designationActorDigest: preflight.review.designationActorDigest, designationAssociationDigest: preflight.review.designationAssociationDigest, reviewDigest: digest(preflight.review), implementationSha: preflight.review.implementationSha, customer: 'not_started', association: 'not_started', attempts: [] };
        store.save(journal);
        try {
            const fresh = await client.readPreflight(plan);
            validatePreflight(plan, fresh);
            requireState(digest(fresh.host) === journal.hostDigest && digest(fresh.associations) === journal.associationsDigest && digest(fresh.review) === journal.reviewDigest, 'preflight_drift');
        }
        catch {
            journal.state = 'finalized';
            journal.preflightFailed = true;
            store.save(journal);
            store.release();
            throw new Error('preflight_failed');
        }
    }
    const persist = () => store.save(journal);
    async function mutation(step, operation) {
        store.assertOwner();
        journal[step] = 'may_be_in_flight';
        journal.attempts.push({ step, outcome: 'may_be_in_flight' });
        persist();
        let result;
        try {
            result = await operation();
        }
        catch {
            result = { outcome: 'ambiguous' };
        }
        const outcome = ['success', 'rejected'].includes(result?.outcome) ? result.outcome : 'ambiguous';
        journal[step] = outcome === 'success' ? 'settled_success' : outcome === 'rejected' ? 'settled_rejected' : 'may_be_in_flight';
        journal.attempts.at(-1).outcome = outcome;
        if (result?.value !== undefined)
            journal.attempts.at(-1).responseDigest = digest(result.value);
        persist();
        return outcome;
    }
    async function readOwned() {
        const customer = uniqueOwned(await client.readCustomers(plan), customerInsert(plan));
        const association = uniqueOwned(await client.readAssociations(plan), associationInsert(plan));
        if (customer) {
            journal.customer = 'settled_success';
            journal.customerDigest = digest(customer);
            if (!customer.deleted_at)
                journal.customerUpdatedAt ??= customer.updated_at;
        }
        if (association) {
            journal.association = 'settled_success';
            journal.associationDigest = digest(association);
        }
        persist();
        return { customer, association };
    }
    async function preserve(association) { const snapshot = await client.readSnapshot(plan); requireState(digest(snapshot.host) === journal.hostDigest, 'host_drift'); const rows = ordered(snapshot.associations); requireState(digest(association ? rows.filter(r => r.id !== plan.associationId) : rows) === journal.associationsDigest && (!association || rows.filter(r => r.id === plan.associationId).length === 1 && digest(rows.find(r => r.id === plan.associationId)) === digest(association)), 'association_drift'); }
    const api = { journal: () => copy(journal),
        async setup() {
            requireState(journal.customer === 'not_started' && journal.association === 'not_started' && journal.state === 'preflight', 'setup_already_started');
            try {
                requireState(await mutation('customer', () => client.createCustomer(customerInsert(plan), plan)) === 'success', 'customer_create_unsettled');
                const customer = uniqueOwned(await client.readCustomers(plan), customerInsert(plan));
                requireState(customer && customer.deleted_at === null, 'customer_readback');
                journal.customerUpdatedAt = customer.updated_at;
                persist();
                requireState(await mutation('association', () => client.createAssociation(associationInsert(plan), plan)) === 'success', 'association_create_unsettled');
                const rows = await readOwned();
                requireState(rows.customer && rows.association, 'setup_readback');
                await preserve(rows.association);
                journal.state = 'ready';
                persist();
            }
            catch {
                journal.state = 'cleanup_required';
                persist();
                throw new Error('cleanup_required');
            }
        },
        async ownershipAttestation(payload) {
            store.assertOwner();
            requireState(journal.state === 'ready', 'fixture_unbound');
            const rows = await readOwned();
            requireState(rows.customer && rows.customer.deleted_at === null && rows.association, 'fixture_unbound');
            await preserve(rows.association);
            const fresh = await client.search(plan);
            requireState(digest(fresh) === digest(payload) && Array.isArray(payload) && payload.length === 1, 'fixture_unbound');
            const row = payload[0];
            requireState(row.customer_id === plan.customerId && row.customer_name === 'Nguyễn An' && row.phone === plan.phone && row.contract_id === C02_HOST && row.is_representative === false && row.contract_status === 'TERMINATED' && row.room_id === preflight.host.room_id && row.building_id === preflight.host.building_id, 'fixture_unbound');
            const proof = { kind: 'owned-c02-v1', state: 'ready', organizationId: DEMO_ORG, customerId: plan.customerId, associationId: plan.associationId, hostId: C02_HOST, roomId: row.room_id, buildingId: row.building_id, actorDigest: journal.actorDigest, contextDigest: journal.contextDigest, phoneDigest: journal.phoneDigest, markerDigest: journal.markerDigest, hostDigest: journal.hostDigest, associationsDigest: journal.associationsDigest, customerDigest: digest(rows.customer), associationDigest: digest(rows.association), responseDigest: digest(payload), reviewDigest: journal.reviewDigest, implementationSha: journal.implementationSha };
            journal.ownershipDigest = digest(proof);
            persist();
            return proof;
        },
        async cleanup() {
            if (journal.state === 'finalized')
                return copy(journal.receipt);
            store.assertOwner();
            try {
                journal.state = 'cleanup_required';
                persist();
                let { customer, association } = await readOwned();
                // A crash can occur after DELETE commits but before its response is
                // journaled. The previously observed create is settled; a durable
                // delete attempt plus exact absence may be reconciled. This must
                // never clear an absent create that is still potentially in flight.
                if (!association && journal.association === 'settled_success'
                    && ['may_be_in_flight', 'settled_success', 'settled_rejected'].includes(journal.associationDelete)) {
                    journal.association = 'cleaned';
                    persist();
                }
                requireState(association || ['not_started', 'settled_rejected', 'cleaned'].includes(journal.association), 'cleanup_required');
                requireState(customer || ['not_started', 'settled_rejected'].includes(journal.customer), 'cleanup_required');
                if (association) {
                    requireState(customer, 'ownership_mismatch');
                    await mutation('associationDelete', () => client.deleteAssociation(plan));
                    requireState((await client.readAssociations(plan)).length === 0, 'cleanup_required');
                    journal.association = 'cleaned';
                    persist();
                }
                if (customer) {
                    journal.customerUpdatedAt ??= customer.updated_at;
                    persist();
                    if (!customer.deleted_at)
                        await mutation('customerSoftDelete', () => client.softDeleteCustomer(plan));
                    customer = uniqueOwned(await client.readCustomers(plan), customerInsert(plan));
                    requireState(customer && typeof customer.deleted_at === 'string' && Number.isFinite(Date.parse(customer.deleted_at)) && Date.parse(customer.updated_at) > Date.parse(journal.customerUpdatedAt), 'cleanup_required');
                    requireState((await client.search(plan)).every(row => row.customer_id !== plan.customerId), 'cleanup_required');
                    journal.customer = 'cleaned';
                    persist();
                }
                requireState((await client.readAssociations(plan)).length === 0, 'cleanup_required');
                await preserve();
                journal.receipt = { state: 'finalized', customerId: plan.customerId, associationId: plan.associationId, actorDigest: journal.actorDigest, contextDigest: journal.contextDigest, ownershipDigest: journal.ownershipDigest ?? null, customerSoftDeleted: Boolean(customer), physicalCustomerDeletion: false, retainedSyntheticTombstone: Boolean(customer), customerDigest: customer ? digest(customer) : null, hostDigest: journal.hostDigest, associationsDigest: journal.associationsDigest };
                journal.state = 'finalized';
                persist();
                store.release();
                return copy(journal.receipt);
            }
            catch (error) {
                journal.state = 'cleanup_required';
                persist();
                throw error;
            }
        },
    };
    return api;
}
