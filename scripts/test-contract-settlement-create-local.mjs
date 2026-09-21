#!/usr/bin/env node
// Existing source writers through authenticated JWT; isolated loopback fixtures only.
import fs from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import ts from "typescript";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID, createHmac } from "node:crypto";
const db = new pg.Client({
  connectionString: "postgresql://postgres@127.0.0.1:55488/postgres",
});
const org = randomUUID(),
  otherOrg = randomUUID(),
  actor = randomUUID(),
  outsider = randomUUID(),
  membership = randomUUID(),
  building = randomUUID(),
  room = randomUUID(),
  customer = randomUUID();
const contracts = Array.from({ length: 4 }, randomUUID),
  deposit = randomUUID(),
  termination = randomUUID();
const key = "T6-" + randomUUID(),
  created = [],
  seededPermissions = [];
// Execute the actual adapter/parser sources, transpiled without changing their logic.
const runtime = path.resolve(
  ".superpowers/sdd/2026-09-20-hop-dong-quyet-toan/t6-local-runtime",
);
fs.mkdirSync(runtime, { recursive: true });
for (const name of [
  "rpcNullable",
  "contractSettlementCreate",
  "contractSettlementCreateReader",
  "incomeExpenseActionSnapshot",
]) {
  const input = fs.readFileSync(`src/lib/${name}.ts`, "utf8");
  const output = ts
    .transpileModule(input, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/(from ["']\.\/[^"']+)(["'])/g, "$1.mjs$2");
  fs.writeFileSync(path.join(runtime, name + ".mjs"), output);
}
const { createContractSettlementVoucher } = await import(
  pathToFileURL(path.join(runtime, "contractSettlementCreate.mjs")).href
);
const {
  parseSettlementCreateSource,
  parseSettlementRefundPreview,
  parseSettlementRefundObligation,
} = await import(
  pathToFileURL(path.join(runtime, "contractSettlementCreateReader.mjs")).href
);
const { parseActionSnapshotBatch } = await import(
  pathToFileURL(path.join(runtime, "incomeExpenseActionSnapshot.mjs")).href
);
async function fixture(fn) {
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL session_replication_role=replica");
    await fn();
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
function jwt(user) {
  const secret = fs
    .readFileSync(
      ".superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest.conf",
      "utf8",
    )
    .match(/jwt-secret = "([^"]+)"/)[1];
  const b = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const body =
    b({ alg: "HS256", typ: "JWT" }) +
    "." +
    b({
      role: "authenticated",
      sub: user,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  return (
    body + "." + createHmac("sha256", secret).update(body).digest("base64url")
  );
}
async function rpc(name, args, user = actor) {
  const r = await fetch("http://127.0.0.1:55489/rpc/" + name, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + jwt(user),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const body = await r.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    data = { message: body, code: `HTTP_${r.status}` };
  }
  return { status: r.status, data };
}
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
const read = (kind, id, user = actor) =>
  rpc(
    "read_contract_settlement_create_source_v1",
    {
      p_organization_id: org,
      p_kind: kind,
      p_source_id: id,
      p_proposed_amount: 100,
    },
    user,
  );
const refFor = (kind, id) =>
  kind === "sale_deposit"
    ? { kind, organizationId: org, depositVoucherId: id }
    : kind === "termination_refund"
      ? {
          kind,
          organizationId: org,
          terminationId: id,
          obligationId: null,
          obligationVersion: null,
        }
      : { kind, organizationId: org, contractId: id };
const sourceId = (ref) =>
  ref.depositVoucherId ?? ref.terminationId ?? ref.contractId;
const call = async (name, args) => {
  const result = await rpc(name, args);
  if (result.status !== 200)
    throw Object.assign(new Error(result.data.message), {
      code: result.data.code,
    });
  return result.data;
};
const ports = {
  readSource: async (ref, amount) =>
    parseSettlementCreateSource(
      await call("read_contract_settlement_create_source_v1", {
        p_organization_id: org,
        p_kind: ref.kind,
        p_source_id: sourceId(ref),
        p_proposed_amount: amount ?? null,
      }),
      ref,
      actor,
    ),
  readVoucher: async (id) => {
    const data = await call("read_income_expense_action_snapshots_v1", {
      p_organization_id: org,
      p_voucher_ids: [id],
    });
    const batch = parseActionSnapshotBatch(
      data,
      { actorId: actor, organizationId: org },
      [id],
    );
    assert.ok(batch.rows[id], JSON.stringify(batch.unavailable));
    return batch.rows[id];
  },
  createCommission: (args) => call("create_commission_voucher", args),
  createDeposit: (args) => call("create_sale_bonus_from_deposit_v1", args),
  previewRefund: async (id) =>
    parseSettlementRefundPreview(
      await call("preview_termination_refund_v1", { p_termination_id: id }),
    ),
  recordObligation: (id) =>
    call("record_termination_refund_obligation_v1", { p_termination_id: id }),
  readObligation: async (id, ref) => {
    const source = await ports.readSource(ref);
    assert.ok(source.latestObligation);
    assert.equal(source.latestObligation.id, id);
    return source.latestObligation;
  },
  createRefund: (args) => call("create_termination_refund_voucher_v1", args),
};
async function adapterCreate(kind, id) {
  const ref = refFor(kind, id),
    source = await ports.readSource(ref, 100);
  return {
    status: 200,
    data: await createContractSettlementVoucher(
      {
        actorId: actor,
        sourceRef: ref,
        expectedRevision: source.revision,
        draft: {
          amount: 100,
          voucherDate: source.today,
          payerName: "T6 payee",
          recipientName:
            kind === "termination_refund"
              ? "T6 refund recipient"
              : "T6 recipient",
          bank: "VCB",
          accountNumber: "123",
          itemDescription: key,
          attachments: [],
          force: false,
          forceReason: "",
          forceConfirmed: false,
        },
      },
      ports,
    ),
  };
}
async function creation(fn, kind, id) {
  const response = ok(await fn());
  const voucherId = response.id ?? response.voucherId;
  created.push(voucherId);
  const source = ok(await read(kind, id));
  assert.equal(source.existingVoucherId, voucherId);
  const voucher = (
    await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [
      voucherId,
    ])
  ).rows[0];
  assert.equal(voucher.account_id, null);
  assert.equal(voucher.approval_status, "UNAPPROVED");
  assert.equal(voucher.review_state, "PENDING");
  assert.equal(voucher.posting_status, "UNPOSTED");
  assert.equal(voucher.active_posting_id_v2, null);
  assert.equal(Number(voucher.total_amount), 100);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.income_expense_postings WHERE voucher_id=$1",
        [voucherId],
      )
    ).rows[0].n,
    0,
  );
  return voucherId;
}
await db.connect();
try {
  await fixture(async () => {
    for (const id of [org, otherOrg])
      await db.query(
        "INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,$2,'ACTIVE')",
        [id, key + id],
      );
    for (const id of [actor, outsider])
      await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
        id,
        id + "@example.invalid",
      ]);
    await db.query(
      "INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE'),($4,$5,$6,'STAFF','ACTIVE')",
      [membership, org, actor, randomUUID(), otherOrg, outsider],
    );
    await db.query(
      "INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,$4,'','','')",
      [building, actor, org, key],
    );
    await db.query(
      "INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,$4,1000,100)",
      [room, org, building, key],
    );
    await db.query(
      "INSERT INTO public.customers(id,user_id,organization_id,full_name,phone,bank_name,bank_account_number) VALUES($1,$2,$3,'Recipient T6','0900000000','VCB','123')",
      [customer, actor, org],
    );
    for (const id of contracts) {
      await db.query(
        "INSERT INTO public.contracts(id,user_id,organization_id,room_id,signed_date,start_date,end_date,rent_price,total_deposit,public_code,notes) VALUES($1,$2,$3,$4,current_date,current_date-10,current_date+355,1000,100,$5,$5)",
        [id, actor, org, room, key + id],
      );
      await db.query(
        "INSERT INTO public.contract_customers(contract_id,customer_id,is_representative) VALUES($1,$2,true)",
        [id, customer],
      );
    }
    const type = randomUUID();
    await db.query(
      "INSERT INTO public.income_expense_types(id,user_id,organization_id,name,type,is_deposit) VALUES($1,$2,$3,'T6 deposit','income',true)",
      [type, actor, org],
    );
    await db.query(
      "INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,type,name,code,voucher_date,total_amount,approval_status,posting_status,review_state,review_version,approval_version,posting_version) VALUES($1,$2,$3,$4,$5,'INCOME',$6,$6,current_date,100,'UNAPPROVED','UNPOSTED','PENDING',1,1,1)",
      [deposit, actor, org, building, room, key],
    );
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,organization_id,description,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,$4,1,100,100,'DEPOSIT')",
      [deposit, type, org, key],
    );
    await db.query(
      "INSERT INTO public.contract_terminations(id,contract_id,organization_id,termination_date,actual_move_out_date,termination_type,status,total_deposit,user_id,refund_method) VALUES($1,$2,$3,current_date,current_date,'NORMAL','APPROVED',100,$4,'TM')",
      [termination, contracts[2], org, actor],
    );
    const scope = randomUUID();
    await db.query(
      "INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)",
      [scope, org, building],
    );
    for (const permission of [
      "buildings.view",
      "income_expenses.view",
      "income_expenses.edit",
      "income_expenses.approve",
    ]) {
      const [resource, action] = permission.split(".");
      const added = await db.query(
        "INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key",
        [permission, resource, action, action === "view" ? "VIEW" : "ELEVATED"],
      );
      if (added.rowCount) seededPermissions.push(permission);
      const override = randomUUID();
      await db.query(
        "INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T6 fixture',$5,'SCOPED')",
        [override, org, membership, permission, actor],
      );
      await db.query(
        "INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)",
        [org, override, scope],
      );
    }
  });
  for (const [kind, id] of [
    ["broker", contracts[0]],
    ["sale_contract", contracts[1]],
    ["sale_deposit", deposit],
    ["termination_refund", termination],
  ]) {
    const s = ok(await read(kind, id));
    assert.equal(s.actorId, actor);
    assert.equal(s.sourceId, id);
    assert.equal(s.existingVoucherId, null);
    assert.equal(s.canCreate, true, kind + JSON.stringify(s));
    assert.equal((await read(kind, id, outsider)).status, 403);
  }
  const commission = (id, kind) =>
    rpc("create_commission_voucher", {
      p_contract_id: id,
      p_kind: kind,
      p_amount: 100,
      p_voucher_date: "2026-09-21",
      p_account_id: null,
      p_payer_name: "T6 payee",
      p_recipient_name: "T6 recipient",
      p_recipient_bank: "VCB",
      p_recipient_account: "123",
      p_item_description: key,
      p_attachments: [],
    });
  const broker = await creation(
    () => adapterCreate("broker", contracts[0]),
    "broker",
    contracts[0],
  );
  await creation(
    () => adapterCreate("sale_contract", contracts[1]),
    "sale_contract",
    contracts[1],
  );
  await creation(
    () => adapterCreate("sale_deposit", deposit),
    "sale_deposit",
    deposit,
  );
  const duplicate = await commission(contracts[0], "broker");
  assert.notEqual(duplicate.status, 200);
  assert.equal(
    ok(await read("broker", contracts[0])).existingVoucherId,
    broker,
  );
  const competing = await Promise.all([
    commission(contracts[3], "broker"),
    commission(contracts[3], "broker"),
  ]);
  assert.equal(competing.filter((result) => result.status === 200).length, 1);
  const claimed = ok(competing.find((result) => result.status === 200)).id;
  assert.equal(
    ok(await read("broker", contracts[3])).existingVoucherId,
    claimed,
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET approval_status='CANCELLED' WHERE id=$1",
      [claimed],
    ),
  );
  assert.equal(ok(await read("broker", contracts[3])).existingVoucherId, null);
  const replacement = await creation(
    () => commission(contracts[3], "broker"),
    "broker",
    contracts[3],
  );
  assert.notEqual(replacement, claimed);
  await fixture(() =>
    db.query("UPDATE public.contracts SET deleted_at=now() WHERE id=$1", [
      contracts[3],
    ]),
  );
  assert.equal((await read("broker", contracts[3])).status, 403);
  assert.notEqual((await commission(contracts[3], "broker")).status, 200);
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET has_restricted_item=true,user_id=$2 WHERE id=$1",
      [broker, outsider],
    ),
  );
  const hidden = ok(await read("broker", contracts[0]));
  assert.equal(hidden.hiddenExisting, true);
  assert.equal(hidden.existingVoucherId, null);
  assert.equal(JSON.stringify(hidden).includes(broker), false);
  const preview = ok(
    await rpc("preview_termination_refund_v1", {
      p_termination_id: termination,
    }),
  );
  assert.equal(preview.requestedAmount, 100);
  const obligation = ok(
    await rpc("record_termination_refund_obligation_v1", {
      p_termination_id: termination,
    }),
  );
  const denied = await rpc("create_termination_refund_voucher_v1", {
    p_obligation_id: obligation.obligationId,
    p_account_id: null,
    p_force: true,
    p_force_reason: "T6 force denial",
  });
  assert.equal(denied.status, 403);
  // Local prepared cash fixture has a matching active posting. Production fixtures use real writers.
  const realReceipt = randomUUID(),
    account = randomUUID(),
    posting = randomUUID();
  await fixture(async () => {
    await db.query(
      "INSERT INTO public.accounts(id,user_id,organization_id,name,code,is_virtual) VALUES($1,$2,$3,$4,$4,false)",
      [account, actor, org, key],
    );
    await db.query(
      "INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,contract_id,type,name,code,voucher_date,total_amount,approval_status,posting_status,review_state,review_version,approval_version,posting_version,account_id,active_posting_id_v2) VALUES($1,$2,$3,$4,$5,$6,'INCOME',$7,$7,current_date,100,'APPROVED','POSTED','PENDING',1,1,1,$8,$9)",
      [
        realReceipt,
        actor,
        org,
        building,
        room,
        contracts[2],
        key + "-real",
        account,
        posting,
      ],
    );
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,organization_id,description,quantity,unit_price,amount,accounting_class) SELECT $1,income_expense_type_id,$2,'T6 real held',1,100,100,'DEPOSIT' FROM public.income_expense_items WHERE income_expense_id=$3",
      [realReceipt, org, deposit],
    );
    await db.query(
      "INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) VALUES($1,$2,$3,$3,'INCOME',$4,100,100,'VOUCHER_TOTAL',100,current_date,$5,$6,1,'POSTING',$7,'USER',1)",
      [posting, org, realReceipt, account, membership, actor, key],
    );
  });
  const positive = ok(await read("termination_refund", termination));
  assert.equal(positive.refund.realHeld, 100);
  assert.equal(positive.refund.obligationStatus, "OK");
  assert.equal(positive.refund.basis, undefined);
  const recorded = ok(
    await rpc("record_termination_refund_obligation_v1", {
      p_termination_id: termination,
    }),
  );
  const refundArgs = {
    p_obligation_id: recorded.obligationId,
    p_account_id: null,
    p_force: false,
    p_force_reason: null,
    p_recipient_name: " T6 refund recipient ",
    p_recipient_bank: " VCB ",
    p_recipient_account: " 123 ",
  };
  assert.equal(
    (await rpc("create_termination_refund_voucher_v1", refundArgs, outsider))
      .status,
    403,
  );
  const refunded = await creation(
    () => adapterCreate("termination_refund", termination),
    "termination_refund",
    termination,
  );
  const recipient = (
    await db.query(
      "SELECT payer_name,receive_bank_name,receive_bank_account FROM public.income_expenses WHERE id=$1",
      [refunded],
    )
  ).rows[0];
  assert.deepEqual(recipient, {
    payer_name: "T6 refund recipient",
    receive_bank_name: "VCB",
    receive_bank_account: "123",
  });
  const again = ok(
    await rpc("record_termination_refund_obligation_v1", {
      p_termination_id: termination,
    }),
  );
  const replay = await Promise.all([
    rpc("create_termination_refund_voucher_v1", {
      ...refundArgs,
      p_obligation_id: again.obligationId,
      p_recipient_name: "do not overwrite",
    }),
    rpc("create_termination_refund_voucher_v1", {
      p_obligation_id: recorded.obligationId,
      p_account_id: null,
      p_force: false,
      p_force_reason: null,
    }),
  ]);
  for (const result of replay) {
    assert.equal(ok(result).voucherId, refunded);
    assert.equal(result.data.alreadyCreated, true);
  }
  assert.deepEqual(
    (
      await db.query(
        "SELECT payer_name,receive_bank_name,receive_bank_account FROM public.income_expenses WHERE id=$1",
        [refunded],
      )
    ).rows[0],
    recipient,
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET has_restricted_item=true,user_id=$2 WHERE id=$1",
      [refunded, outsider],
    ),
  );
  const hiddenRefund = ok(await read("termination_refund", termination));
  assert.equal(hiddenRefund.hiddenExisting, true);
  assert.equal(JSON.stringify(hiddenRefund).includes(refunded), false);
  console.log(
    "PASS T6 JWT all four NULL-account creation paths, refund recipient birth, real-held preview, force/cross-org denial, concurrent same-source replay and invisible-claim non-disclosure. Live positive-control remains separate.",
  );
} finally {
  await fixture(async () => {
    for (const table of [
      "income_expense_flow_ownership",
      "canonical_write_operations",
      "sale_bonus_claims",
    ])
      await db.query(
        `DELETE FROM app_private.${table} WHERE organization_id=$1`,
        [org],
      );
    await db.query(
      "DELETE FROM public.termination_refund_obligations WHERE organization_id=$1",
      [org],
    );
    await db.query(
      "DELETE FROM public.contract_terminations WHERE organization_id=$1",
      [org],
    );
    await db.query(
      "DELETE FROM public.income_expense_items WHERE organization_id=$1 OR income_expense_id IN (SELECT id FROM public.income_expenses WHERE organization_id=$1)",
      [org],
    );
    await db.query(
      "DELETE FROM public.income_expense_postings WHERE organization_id=$1",
      [org],
    );
    await db.query(
      "DELETE FROM public.income_expenses WHERE organization_id=$1",
      [org],
    );
    await db.query(
      "DELETE FROM public.income_expense_types WHERE organization_id=$1",
      [org],
    );
    await db.query("DELETE FROM public.accounts WHERE organization_id=$1", [
      org,
    ]);
    await db.query(
      "DELETE FROM public.contract_customers WHERE contract_id=ANY($1::uuid[])",
      [contracts],
    );
    await db.query("DELETE FROM public.contracts WHERE id=ANY($1::uuid[])", [
      contracts,
    ]);
    await db.query("DELETE FROM public.customers WHERE id=$1", [customer]);
    await db.query("DELETE FROM public.rooms WHERE id=$1", [room]);
    await db.query("DELETE FROM public.buildings WHERE id=$1", [building]);
    for (const table of [
      "member_override_scopes",
      "member_permission_overrides",
      "authorization_scopes",
      "organization_memberships",
    ])
      await db.query(
        `DELETE FROM public.${table} WHERE organization_id=ANY($1::uuid[])`,
        [[org, otherOrg]],
      );
    await db.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [
      [actor, outsider],
    ]);
    await db.query(
      "DELETE FROM public.organizations WHERE id=ANY($1::uuid[])",
      [[org, otherOrg]],
    );
    await db.query(
      "DELETE FROM public.permission_definitions WHERE key=ANY($1::text[])",
      [seededPermissions],
    );
  });
  await db.end();
}
