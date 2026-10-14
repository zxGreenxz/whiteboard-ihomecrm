import { createHermesFrontendProxy } from '../../../infra/hermes-broker/frontend-proxy.mjs';

export const config = { maxDuration: 60 };
export default createHermesFrontendProxy({ family: 'zalo',
  upstreamOrigin: process.env.HERMES_UPSTREAM_ORIGIN, crmOrigin: process.env.HERMES_CRM_ORIGIN });
