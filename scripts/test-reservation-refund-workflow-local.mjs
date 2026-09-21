#!/usr/bin/env node
// T6R real authenticated JWT against the disposable loopback database only.
import fs from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import ts from "typescript";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
const nativeRequire = createRequire(import.meta.url),
  modules = new Map();
function tsModule(file) {
  const abs = path.resolve(file);
  if (modules.has(abs)) return modules.get(abs);
  const exp = {};
  modules.set(abs, exp);
  const js = ts.transpileModule(fs.readFileSync(abs, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInThisContext("(function(require,exports){" + js + "\n})", {
    filename: abs,
  })(
    (name) =>
      name.startsWith(".")
        ? tsModule(path.resolve(path.dirname(abs), name + ".ts"))
        : nativeRequire(name),
    exp,
  );
  return exp;
}
const domain = tsModule("src/lib/reservationRefundWorkflow.ts"),
  snapshots = tsModule("src/lib/incomeExpenseActionSnapshot.ts");
import { randomUUID, createHmac } from "node:crypto";
const db = new pg.Client({
  connectionString: "postgresql://postgres@127.0.0.1:55488/postgres",
});
const org = randomUUID(),
  otherOrg = randomUUID(),
  actor = randomUUID(),
  outsider = randomUUID(),
  custodianActor = randomUUID(),
  custodianMembership = randomUUID(),
  membership = randomUUID(),
  building = randomUUID(),
  room = randomUUID(),
  account = randomUUID(),
  deposit = randomUUID(),
  key = "T6R-" + randomUUID();
const seededPermissions = [],
  seededFlags = [];
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
      "INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount,status) VALUES($1,$2,$3,$4,1000,100,'AVAILABLE')",
      [room, org, building, key],
    );
    await db.query(
      "INSERT INTO public.accounts(id,user_id,organization_id,name,code,is_virtual) VALUES($1,$2,$3,$4,$4,false)",
      [account, actor, org, key],
    );
    await db.query(
      "INSERT INTO public.cashbook_possession_bindings(organization_id,cashbook_id,membership_id,possession_kind,valid_from) VALUES($1,$2,$3,'CUSTODIAN',now()-interval '1 day')",
      [org, account, membership],
    );
    for (const feature of [
      "income_expense.workflow.v2",
      "income_expense.posting.v2",
      "contract.create.v2",
    ]) {
      const added = await db.query(
        "INSERT INTO app_private.server_feature_flags(feature_key,domain,mode,commit_sha,migration_sha256,maintenance_window_id,approval_reference,starts_at,ends_at,max_operation_count,max_single_amount_vnd,max_total_amount_vnd) VALUES($1,'finance','CANARY','LOCAL_T6R','LOCAL_T6R','LOCAL_T6R','LOCAL_T6R',now()-interval '1 day',now()+interval '1 day',10000,1000000000,10000000000) ON CONFLICT(feature_key) DO NOTHING RETURNING feature_key",
        [feature],
      );
      if (added.rowCount) seededFlags.push(feature);
      await db.query(
        "INSERT INTO app_private.server_feature_flag_canary_orgs(feature_key,organization_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [feature, org],
      );
    }
    const type = randomUUID(),
      post = randomUUID();
    await db.query(
      "INSERT INTO public.income_expense_types(id,user_id,organization_id,name,type,is_deposit) VALUES($1,$2,$3,'T6R deposit','income',true)",
      [type, actor, org],
    );
    await db.query(
      "INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,account_id,active_posting_id_v2,posting_id,payer_name) VALUES($1,$2,$3,$4,$5,'INCOME',$6,$6,current_date,100,'APPROVED','CASHBOOK','POSTED','RESOLVED',1,1,1,$7,$8,$8,'T6R recipient')",
      [deposit, actor, org, building, room, key, account, post],
    );
    await db.query(
      "INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,organization_id,description,quantity,unit_price,amount,accounting_class) VALUES($1,$2,$3,$4,1,100,100,'DEPOSIT')",
      [deposit, type, org, key],
    );
    await db.query(
      "INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) VALUES($1,$2,$3,$3,'INCOME',$4,100,100,'VOUCHER_TOTAL',100,current_date,$5,$6,1,'POSTING',$7,'TEST_FIXTURE',1)",
      [post, org, deposit, account, membership, actor, key],
    );
    await db.query(
      "INSERT INTO public.income_expense_posting_lines(organization_id,posting_id,account_id,line_kind,signed_amount) VALUES($1,$2,$3,'MAIN',100)",
      [org, post, account],
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
      "income_expenses.reverse",
      "deposits.refund",
      "contracts.create",
    ]) {
      const [resource, action] = permission.split(".");
      const added = await db.query(
        "INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','BUILDING'],true) ON CONFLICT(key) DO NOTHING RETURNING key",
        [permission, resource, action, action === "view" ? "VIEW" : "ELEVATED"],
      );
      if (added.rowCount) seededPermissions.push(permission);
      const override = randomUUID();
      await db.query(
        "INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T6R fixture',$5,'SCOPED')",
        [override, org, membership, permission, actor],
      );
      await db.query(
        "INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)",
        [org, override, scope],
      );
    }
  });
  const preview = ok(
    await rpc("preview_reservation_settlement_v1", { p_voucher_id: deposit }),
  );
  assert.equal(preview.canSettle, true, JSON.stringify(preview));
  const today = (
    await db.query("SELECT public.org_today_v1($1)::text today", [org])
  ).rows[0].today;
  const settlement = ok(
    await rpc("settle_reservation_deposit_v1", {
      p_input: {
        voucherId: deposit,
        refundAmount: 100,
        refundMode: "LATER",
        settlementDate: today,
        reasonCode: "CHANGED_MIND",
        reasonText: "",
        refundAccountId: null,
        basisFingerprint: preview.fingerprint,
        idempotencyKey: key + "-settle",
      },
    }),
  );
  assert.equal(settlement.refundVoucherId, null);
  assert.equal(settlement.refundRemaining, 100);
  const readWorkflow = () =>
    rpc("read_reservation_refund_workflow_v1", {
      p_organization_id: org,
      p_source_voucher_id: deposit,
      p_settlement_id: settlement.id,
    });
  const candidate = ok(await readWorkflow());
  assert.equal(candidate.existingVoucherId, null);
  assert.equal(candidate.remaining, 100);
  assert.equal(candidate.basisValid, true);
  assert.equal(candidate.canCreate, true);
  const input = {
    organizationId: org,
    sourceVoucherId: deposit,
    settlementId: settlement.id,
    basisFingerprint: preview.fingerprint,
    expectedRemaining: 100,
    idempotencyKey: key + "-pending",
    recipientName: "T6R payee",
    bank: "VCB",
    accountNumber: "123",
  };
  // Pending birth needs source refund authority, not approval authority.
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='DENY' WHERE organization_id=$1 AND permission_key='income_expenses.approve'",
      [org],
    ),
  );
  const attempts = await Promise.all([
    rpc("create_reservation_refund_pending_v1", { p_input: input }),
    rpc("create_reservation_refund_pending_v1", {
      p_input: { ...input, idempotencyKey: key + "-second-window" },
    }),
  ]);
  const result = attempts[0];
  assert.equal(
    ok(attempts[1]).voucherId,
    ok(result).voucherId,
    "two windows must share one pending identity",
  );
  console.log("Pending creation HTTP status:", result.status);
  const pending = ok(result);
  assert.ok(pending.voucherId);
  assert.equal(ok(await readWorkflow()).existingVoucherId, pending.voucherId);
  const v = (
    await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [
      pending.voucherId,
    ])
  ).rows[0];
  assert.equal(v.account_id, null);
  assert.equal(v.approval_status, "UNAPPROVED");
  assert.equal(v.review_state, "PENDING");
  assert.equal(v.posting_status, "UNPOSTED");
  assert.equal(v.system_source, "reservation.refund");
  assert.equal(v.total_amount, "100.00");
  assert.equal(v.payer_name, "T6R payee");
  assert.equal(v.receive_bank_name, "VCB");
  assert.equal(v.receive_bank_account, "123");
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.income_expense_postings WHERE voucher_id=$1",
        [v.id],
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT sum(signed_amount)::text amount FROM public.income_expense_posting_lines WHERE organization_id=$1",
        [org],
      )
    ).rows[0].amount,
    "100.00",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.reservation_settlement_vouchers WHERE settlement_id=$1 AND kind='REFUND'",
        [settlement.id],
      )
    ).rows[0].n,
    1,
  );
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE organization_id=$1 AND permission_key='income_expenses.approve'",
      [org],
    ),
  );
  const legacyPay = await rpc("pay_reservation_refund_v1", {
    p_input: {
      settlementId: settlement.id,
      accountId: account,
      paidOn: today,
      idempotencyKey: key + "-legacy-pay",
    },
  });
  assert.notEqual(
    legacyPay.status,
    200,
    "old pay must not create a second refund leg beside pending review",
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.reservation_settlement_vouchers WHERE settlement_id=$1 AND kind='REFUND'",
        [settlement.id],
      )
    ).rows[0].n,
    1,
  );
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='DENY' WHERE organization_id=$1 AND permission_key='deposits.refund'",
      [org],
    ),
  );
  assert.equal(
    (await rpc("create_reservation_refund_pending_v1", { p_input: input }))
      .status,
    403,
    "revoked source permission must reject cached pending replay",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE organization_id=$1 AND permission_key='deposits.refund'",
      [org],
    ),
  );
  assert.equal(
    (
      await rpc(
        "create_reservation_refund_pending_v1",
        { p_input: input },
        outsider,
      )
    ).status,
    403,
  );
  assert.notEqual(
    (
      await rpc("create_reservation_refund_pending_v1", {
        p_input: { ...input, recipientName: "Changed" },
      })
    ).status,
    200,
    "a used caller key must reject changed payload",
  );
  console.log(
    "PASS LATER pending birth, two windows, no approval requirement, source-revoked replay denial and old-pay duplicate guard.",
  );
  const baseAction = {
    organizationId: org,
    sourceVoucherId: deposit,
    settlementId: settlement.id,
    basisFingerprint: preview.fingerprint,
    expectedRemaining: 100,
    voucherId: v.id,
    expectedApprovalVersion: Number(v.approval_version),
    expectedPostingVersion: Number(v.posting_version),
    expectedReviewVersion: Number(v.review_version),
  };
  const action = (input, user = actor) =>
    rpc("execute_reservation_refund_action_v1", { p_input: input }, user);
  const request = {
    ...baseAction,
    action: "request_changes",
    reason: "Kiểm tra lại thông tin người nhận",
    idempotencyKey: key + "-request",
  };
  const review = ok(await action(request));
  assert.equal(review.voucherId, v.id);
  assert.equal(review.reviewState, "CHANGES_REQUESTED");
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='DENY' WHERE organization_id=$1 AND permission_key='income_expenses.approve'",
      [org],
    ),
  );
  assert.equal(
    (await action(request)).status,
    403,
    "revoked approver cannot replay request changes",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE organization_id=$1 AND permission_key='income_expenses.approve'",
      [org],
    ),
  );
  assert.equal(ok(await action(request)).reviewVersion, review.reviewVersion);
  const resubmit = {
    ...baseAction,
    action: "resubmit",
    expectedReviewVersion: review.reviewVersion,
    idempotencyKey: key + "-resubmit",
  };
  const returned = ok(await action(resubmit));
  assert.equal(returned.voucherId, v.id);
  assert.equal(returned.reviewState, "PENDING");
  const same = (
    await db.query(
      "SELECT id,code,total_amount,system_source,approval_status,posting_status,account_id FROM public.income_expenses WHERE id=$1",
      [v.id],
    )
  ).rows[0];
  assert.deepEqual(same, {
    id: v.id,
    code: v.code,
    total_amount: v.total_amount,
    system_source: v.system_source,
    approval_status: "UNAPPROVED",
    posting_status: "UNPOSTED",
    account_id: null,
  });
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM public.income_expense_postings WHERE voucher_id=$1",
        [v.id],
      )
    ).rows[0].n,
    0,
  );
  assert.notEqual(
    (
      await action({
        ...resubmit,
        idempotencyKey: key + "-patch",
        patch: { total_amount: 200 },
      })
    ).status,
    200,
  );
  console.log(
    "PASS shared request/resubmit preserves exact voucher identity/source/amount, no approval/posting, and revoked replay denial.",
  );
  const permit = async (permission, effect) =>
    fixture(() =>
      db.query(
        "UPDATE public.member_permission_overrides SET effect=$3 WHERE organization_id=$1 AND permission_key=$2",
        [org, permission, effect],
      ),
    );
  const voucher = async () =>
    (await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [v.id]))
      .rows[0];
  const cash = async () =>
    Number(
      (
        await db.query(
          "SELECT COALESCE(sum(signed_amount),0)::text amount FROM public.income_expense_posting_lines WHERE organization_id=$1",
          [org],
        )
      ).rows[0].amount,
    );
  const versions = async () => {
    const x = await voucher();
    return {
      expectedApprovalVersion: Number(x.approval_version),
      expectedPostingVersion: Number(x.posting_version),
      expectedReviewVersion: Number(x.review_version),
    };
  };
  const secondRequest = {
    ...baseAction,
    ...(await versions()),
    action: "request_changes",
    reason: "Đối chiếu lại người nhận",
    idempotencyKey: key + "-second-request",
  };
  const secondReview = ok(await action(secondRequest));
  await permit("income_expenses.edit", "DENY");
  const makerSubmit = {
    ...baseAction,
    ...(await versions()),
    action: "resubmit",
    expectedReviewVersion: secondReview.reviewVersion,
    idempotencyKey: key + "-maker-no-edit",
  };
  ok(await action(makerSubmit));
  await fixture(() =>
    db.query(
      "UPDATE public.organization_memberships SET valid_to=now()-interval '1 second' WHERE id=$1",
      [membership],
    ),
  );
  assert.equal(
    (await action(makerSubmit)).status,
    403,
    "expired maker membership cannot replay resubmit",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.organization_memberships SET valid_to=NULL WHERE id=$1",
      [membership],
    ),
  );
  const legacyReview = ok(
    await action({
      ...secondRequest,
      ...(await versions()),
      idempotencyKey: key + "-legacy-request",
    }),
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET maker_user_id=NULL WHERE id=$1",
      [v.id],
    ),
  );
  const legacySubmit = {
    ...baseAction,
    ...(await versions()),
    action: "resubmit",
    expectedReviewVersion: legacyReview.reviewVersion,
    idempotencyKey: key + "-legacy-resubmit",
  };
  assert.equal(
    (await action(legacySubmit)).status,
    403,
    "legacy NULL maker requires actual edit permission",
  );
  await permit("income_expenses.edit", "ALLOW");
  ok(await action(legacySubmit));
  await permit("income_expenses.edit", "DENY");
  assert.equal(
    (await action(legacySubmit)).status,
    403,
    "revoked legacy edit denies cached resubmit",
  );
  await permit("income_expenses.edit", "ALLOW");
  await fixture(() =>
    db.query("UPDATE public.income_expenses SET maker_user_id=$2 WHERE id=$1", [
      v.id,
      actor,
    ]),
  );
  assert.notEqual(
    (
      await rpc("approve_income_expense_v2", {
        p_voucher: v.id,
        p_expected_approval_version: Number(v.approval_version),
        p_idempotency_key: key + "-generic",
      })
    ).status,
    200,
    "generic approval must not bypass reservation source guard",
  );
  const approval = {
    ...baseAction,
    ...(await versions()),
    action: "approve",
    idempotencyKey: key + "-approve",
  };
  await permit("deposits.refund", "DENY");
  const approved = ok(await action(approval));
  assert.equal(approved.approvalStatus, "APPROVED");
  assert.equal(await cash(), 100);
  assert.equal((await voucher()).account_id, null);
  await permit("income_expenses.approve", "DENY");
  assert.equal(
    (await action(approval)).status,
    403,
    "revoked approval rejects cached approval result",
  );
  const evidence = async () => {
    const id = randomUUID();
    await fixture(() =>
      db.query(
        "INSERT INTO public.finance_evidence_objects(id,organization_id,bucket_id,object_name,uploader_membership_id,uploader_user_id,provenance_kind,state,finalized_at) VALUES($1,$2,'income-expense-attachments',$3,$4,$5,'UPLOAD','FINALIZED',now())",
        [id, org, actor + "/" + id + ".png", membership, actor],
      ),
    );
    return id;
  };
  const post = {
    ...baseAction,
    ...(await versions()),
    action: "post",
    cashbookId: account,
    postedOn: today,
    evidenceIds: [],
    idempotencyKey: key + "-post-no-proof",
  };
  assert.notEqual(
    (await action(post)).status,
    200,
    "posting requires shared finalized evidence",
  );
  assert.equal(await cash(), 100);
  const realPost = {
    ...post,
    evidenceIds: [await evidence()],
    idempotencyKey: key + "-post",
  };
  assert.notEqual(
    (
      await action({
        ...realPost,
        expectedPostingVersion: 999,
        idempotencyKey: key + "-stale",
      })
    ).status,
    200,
    "stale posting CAS denied",
  );
  const paid = ok(await action(realPost));
  assert.equal(paid.postingStatus, "POSTED");
  assert.equal(
    await cash(),
    0,
    "post-only can execute without approve or deposits.refund",
  );
  assert.equal(
    (
      await db.query(
        "SELECT source_kind FROM public.income_expense_postings WHERE voucher_id=$1 AND event_kind='POSTING'",
        [v.id],
      )
    ).rows[0].source_kind,
    "RESERVATION_REFUND",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.cashbook_possession_bindings SET valid_to=now()-interval '1 second' WHERE organization_id=$1",
      [org],
    ),
  );
  assert.equal(
    (await action(realPost)).status,
    403,
    "revoked custody denies cached posting replay",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.cashbook_possession_bindings SET valid_to=NULL WHERE organization_id=$1",
      [org],
    ),
  );
  const reverse = {
    ...baseAction,
    ...(await versions()),
    expectedRemaining: 0,
    action: "reverse",
    cashbookId: account,
    postedOn: today,
    reason: "Hoàn tác để đối chiếu chứng từ",
    idempotencyKey: key + "-reverse",
  };
  const reversed = ok(await action(reverse));
  assert.equal(await cash(), 100);
  assert.equal((await voucher()).posting_status, "REVERSED");
  await permit("income_expenses.reverse", "DENY");
  assert.equal(
    (await action(reverse)).status,
    403,
    "revoked reverse permission denies cached replay",
  );
  await permit("income_expenses.reverse", "ALLOW");
  ok(await action(realPost));
  assert.equal(
    await cash(),
    100,
    "old successful posting key after reverse must never repay",
  );
  const freshPost = {
    ...realPost,
    ...(await versions()),
    evidenceIds: [await evidence()],
    idempotencyKey: key + "-repost",
  };
  const race = await Promise.all([
    action(freshPost),
    action({ ...freshPost, idempotencyKey: key + "-other-post-window" }),
  ]);
  assert.equal(
    race.filter((r) => r.status === 200).length,
    1,
    "two payout windows must post once",
  );
  assert.equal(await cash(), 0);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT app_private.reservation_settlement_refunded_v1($1)::text amount",
          [settlement.id],
        )
      ).rows[0].amount,
    ),
    100,
  );
  const reverseVersions = await versions();
  const reverseRace = await Promise.all([
    action({
      ...baseAction,
      ...reverseVersions,
      expectedRemaining: 0,
      action: "reverse",
      cashbookId: account,
      postedOn: today,
      reason: "Hoàn tác qua nguồn",
      idempotencyKey: key + "-source-reverse-race",
    }),
    rpc("reverse_posted_income_expense_v2", {
      p_voucher: v.id,
      p_cashbook: account,
      p_posted_on: today,
      p_reason: "Hoàn tác tương thích đồng thời",
      p_idempotency_key: key + "-compat-reverse-race",
    }),
  ]);
  assert.equal(
    reverseRace.filter((result) => result.status === 200).length,
    1,
    "source and compatibility reverse serialize to one winner",
  );
  assert.equal(
    reverseRace.some((result) => result.data?.code === "40P01"),
    false,
    "source and compatibility reverse must not deadlock",
  );
  assert.equal((await voucher()).posting_status, "REVERSED");
  console.log(
    "PASS approve-only, custody-only post, source-labelled evidence posting, CAS, revoked authority replay, reverse/old-key/new-key, two payout windows and compatibility reverse lock order.",
  );
  const freshSource = async () => {
    const id = randomUUID(),
      post = randomUUID();
    await fixture(async () => {
      await db.query(
        "INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,room_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,account_id,active_posting_id_v2,posting_id) SELECT $1,user_id,organization_id,building_id,room_id,type,name,$2,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,account_id,$3,$3 FROM public.income_expenses WHERE id=$4",
        [id, key + id, post, deposit],
      );
      await db.query(
        "INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,organization_id,description,quantity,unit_price,amount,accounting_class) SELECT $1,income_expense_type_id,organization_id,description,quantity,unit_price,amount,accounting_class FROM public.income_expense_items WHERE income_expense_id=$2",
        [id, deposit],
      );
      await db.query(
        "INSERT INTO public.income_expense_postings(id,organization_id,voucher_id,posting_subject_id,direction,account_id,gross_amount,voucher_amount_snapshot,amount_basis,net_cash_effect,posted_on,posted_by_membership_id,posted_by_user_id,approval_version,event_kind,idempotency_key,source_kind,posting_generation) VALUES($1,$2,$3,$3,'INCOME',$4,100,100,'VOUCHER_TOTAL',100,current_date,$5,$6,1,'POSTING',$7,'TEST_FIXTURE',1)",
        [post, org, id, account, membership, actor, key + id],
      );
      await db.query(
        "INSERT INTO public.income_expense_posting_lines(organization_id,posting_id,account_id,line_kind,signed_amount) VALUES($1,$2,$3,'MAIN',100)",
        [org, post, account],
      );
    });
    return {
      id,
      preview: ok(
        await rpc("preview_reservation_settlement_v1", { p_voucher_id: id }),
      ),
    };
  };
  const settleSource = async (source, amount = 100, mode = "LATER") =>
    ok(
      await rpc("settle_reservation_deposit_v1", {
        p_input: {
          voucherId: source.id,
          refundAmount: amount,
          refundMode: mode,
          settlementDate: today,
          reasonCode: "CHANGED_MIND",
          reasonText: "",
          refundAccountId: mode === "NOW" ? account : null,
          basisFingerprint: source.preview.fingerprint,
          idempotencyKey: key + "-" + source.id,
        },
      }),
    );
  await permit("income_expenses.approve", "ALLOW");
  await permit("deposits.refund", "ALLOW");
  async function contractCandidate() {
    const source = await freshSource(),
      newRoom = randomUUID(),
      customer = randomUUID();
    await fixture(async () => {
      await db.query(
        "INSERT INTO public.rooms(id,organization_id,building_id,name,status,rent_price,deposit_amount) VALUES($1,$2,$3,$4,'RESERVED',100,100)",
        [newRoom, org, building, key + newRoom],
      );
      await db.query(
        "UPDATE public.income_expenses SET room_id=$2 WHERE id=$1",
        [source.id, newRoom],
      );
      await db.query(
        "INSERT INTO public.customers(id,user_id,organization_id,full_name,phone) VALUES($1,$2,$3,'T6R source race',$4)",
        [
          customer,
          actor,
          org,
          "09" +
            String(parseInt(customer.slice(0, 8), 16))
              .slice(-8)
              .padStart(8, "0"),
        ],
      );
    });
    source.preview = ok(
      await rpc("preview_reservation_settlement_v1", {
        p_voucher_id: source.id,
      }),
    );
    return {
      source,
      payload: {
        contract: {
          room_id: newRoom,
          start_date: today,
          end_date: today,
          rent_price: 100,
          total_deposit: 100,
        },
        customers: [{ customer_id: customer, is_representative: true }],
        existing_deposit_voucher_ids: [source.id],
      },
    };
  }
  const positive = await contractCandidate();
  ok(
    await rpc("create_contract_v2", {
      p_payload: positive.payload,
      p_idempotency_key: key + "-contract-positive",
    }),
  );
  const contested = await contractCandidate();
  const sourceRace = await Promise.all([
    rpc("create_contract_v2", {
      p_payload: contested.payload,
      p_idempotency_key: key + "-contract-race",
    }),
    rpc("settle_reservation_deposit_v1", {
      p_input: {
        voucherId: contested.source.id,
        refundAmount: 100,
        refundMode: "LATER",
        settlementDate: today,
        reasonCode: "CHANGED_MIND",
        reasonText: "",
        refundAccountId: null,
        basisFingerprint: contested.source.preview.fingerprint,
        idempotencyKey: key + "-settle-race",
      },
    }),
  ]);
  assert.equal(
    sourceRace.filter((x) => x.status === 200).length,
    1,
    JSON.stringify(sourceRace),
  );
  assert.ok(
    sourceRace.every((x) => x.data?.code !== "40P01"),
    "no source signing deadlock",
  );
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT (SELECT count(*) FROM public.reservation_deposit_settlements WHERE source_voucher_id=$1)+(SELECT count(*) FROM public.contract_deposit_links WHERE income_expense_id=$1) n",
          [contested.source.id],
        )
      ).rows[0].n,
    ),
    1,
    "exactly one source consumer",
  );
  console.log(
    "PASS real JWT contract signing positive control + race settlement: one consumer, no deadlock",
  );
  const partialSource = await freshSource(),
    partial = await settleSource(partialSource, 40);
  const partialInput = {
    ...input,
    sourceVoucherId: partialSource.id,
    settlementId: partial.id,
    basisFingerprint: partialSource.preview.fingerprint,
    expectedRemaining: 40,
    idempotencyKey: key + "-partial-pending",
  };
  assert.notEqual(
    (
      await rpc("create_reservation_refund_pending_v1", {
        p_input: { ...partialInput, expectedRemaining: 39 },
      })
    ).status,
    200,
    "pending creation cannot change full remaining",
  );
  const partialVoucher = ok(
    await rpc("create_reservation_refund_pending_v1", {
      p_input: partialInput,
    }),
  ).voucherId;
  const partialRow = (
    await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [
      partialVoucher,
    ])
  ).rows[0];
  const atomic = {
    ...baseAction,
    sourceVoucherId: partialSource.id,
    settlementId: partial.id,
    basisFingerprint: partialSource.preview.fingerprint,
    expectedRemaining: 40,
    voucherId: partialVoucher,
    expectedApprovalVersion: Number(partialRow.approval_version),
    expectedReviewVersion: Number(partialRow.review_version),
    expectedPostingVersion: Number(partialRow.posting_version),
    action: "approve_and_post",
    cashbookId: account,
    postedOn: today,
    evidenceIds: [await evidence()],
    idempotencyKey: key + "-atomic",
  };
  const beforeAtomic = await cash();
  await permit("income_expenses.approve", "DENY");
  assert.equal((await action(atomic)).status, 403);
  await permit("income_expenses.approve", "ALLOW");
  await fixture(() =>
    db.query("UPDATE public.accounts SET lock_date=$2 WHERE id=$1", [
      account,
      today,
    ]),
  );
  assert.notEqual(
    (await action(atomic)).status,
    200,
    "locked period rejects approval+posting atomically",
  );
  assert.equal(await cash(), beforeAtomic);
  assert.equal(
    (
      await db.query(
        "SELECT approval_status FROM public.income_expenses WHERE id=$1",
        [partialVoucher],
      )
    ).rows[0].approval_status,
    "UNAPPROVED",
  );
  await fixture(() =>
    db.query("UPDATE public.accounts SET lock_date=NULL WHERE id=$1", [
      account,
    ]),
  );
  await permit("deposits.refund", "DENY");
  ok(await action(atomic));
  await permit('income_expenses.approve','DENY');
  assert.equal((await action(atomic)).status,403,'revoked approver cannot replay atomic approval+posting');
  await permit('income_expenses.approve','ALLOW');
  assert.equal(await cash(), beforeAtomic - 40);
  assert.equal(
    Number(
      (
        await db.query(
          "SELECT app_private.reservation_settlement_refunded_v1($1)::text amount",
          [partial.id],
        )
      ).rows[0].amount,
    ),
    40,
  );
  await permit("deposits.refund", "ALLOW");
  const oldSource = await freshSource(),
    oldSettlement = await settleSource(oldSource),
    oldPayInput = {
      settlementId: oldSettlement.id,
      accountId: account,
      paidOn: today,
      idempotencyKey: key + "-old-compat",
    };
  const beforeOld = await cash(),
    oldPaid = ok(
      await rpc("pay_reservation_refund_v1", { p_input: oldPayInput }),
    );
  assert.equal(await cash(), beforeOld - 100);
  ok(
    await rpc("reverse_posted_income_expense_v2", {
      p_voucher: oldPaid.refundVoucherId,
      p_cashbook: account,
      p_posted_on: today,
      p_reason: "Kiểm tra hoàn tác rồi chi lại",
      p_idempotency_key: key + "-old-reverse",
    }),
  );
  assert.equal(await cash(), beforeOld);
  const oldRetry = ok(
    await rpc("pay_reservation_refund_v1", { p_input: oldPayInput }),
  );
  assert.equal(oldRetry.refundState, "PENDING");
  assert.equal(await cash(), beforeOld);
  const oldNew = ok(
    await rpc("pay_reservation_refund_v1", {
      p_input: { ...oldPayInput, idempotencyKey: key + "-old-new-key" },
    }),
  );
  assert.notEqual(oldNew.refundVoucherId, oldPaid.refundVoucherId);
  assert.equal(await cash(), beforeOld - 100);
  const nowSource = await freshSource(),
    beforeNow = await cash(),
    nowSettled = await settleSource(nowSource, 100, "NOW");
  assert.equal(nowSettled.refundState, "PAID");
  assert.equal(await cash(), beforeNow - 100);
  console.log(
    "PASS atomic partial-obligation/full-remaining/custody/period rollback; unchanged NOW and old-pay reverse retry/new-key semantics.",
  );
  await assert.rejects(
    db.query("UPDATE public.income_expenses SET total_amount=101 WHERE id=$1", [
      v.id,
    ]),
    (e) => e.code === "55000",
    "manual SQL cannot change a reservation leg",
  );
  await assert.rejects(
    db.query(
      "UPDATE public.income_expense_items SET amount=101 WHERE income_expense_id=$1",
      [deposit],
    ),
    (e) => e.code === "55000",
    "settled received source stays frozen",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET has_restricted_item=true,user_id=$2 WHERE id=$1",
      [v.id, outsider],
    ),
  );
  const hidden = await rpc("create_reservation_refund_pending_v1", {
    p_input: input,
  });
  assert.equal(hidden.status, 403);
  const hiddenWorkflow = ok(await readWorkflow());
  assert.equal(hiddenWorkflow.hiddenExisting, true);
  assert.equal(hiddenWorkflow.existingVoucherId, null);
  assert.equal(hiddenWorkflow.canCreate, false);
  assert.equal(JSON.stringify(hiddenWorkflow).includes(v.id), false);
  assert.equal(
    JSON.stringify(hidden).includes(v.id),
    false,
    "hidden existing pending identity must not leak",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expenses SET has_restricted_item=false,user_id=$2 WHERE id=$1",
      [v.id, actor],
    ),
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expense_items SET amount=101 WHERE income_expense_id=$1",
      [deposit],
    ),
  );
  assert.notEqual(
    (await action(realPost)).status,
    200,
    "received-proof/basis drift rejects even a cached payout response",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.income_expense_items SET amount=100 WHERE income_expense_id=$1",
      [deposit],
    ),
  );
  await db.query("BEGIN");
  try {
    await db.query("SET LOCAL ROLE authenticated");
    await assert.rejects(
      db.query(
        "INSERT INTO app_private.reservation_settlement_write_tokens(settlement_id,xid) VALUES($1,pg_current_xact_id())",
        [settlement.id],
      ),
      (e) => e.code === "42501",
      "client cannot forge specialized source token",
    );
  } finally {
    await db.query("ROLLBACK");
  }
  console.log(
    "PASS maker/edit distinction, revoked resubmit authority, source/leg freeze, hidden identity, received-basis drift and token isolation.",
  );
  await fixture(async () => {
    await db.query("INSERT INTO auth.users(id,email) VALUES($1,$2)", [
      custodianActor,
      custodianActor + "@example.invalid",
    ]);
    await db.query(
      "INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')",
      [custodianMembership, org, custodianActor],
    );
    const scope = (
      await db.query(
        "SELECT id FROM public.authorization_scopes WHERE organization_id=$1 AND building_id=$2",
        [org, building],
      )
    ).rows[0].id;
    for (const permission of ["buildings.view", "income_expenses.view"]) {
      const override = randomUUID();
      await db.query(
        "INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T6R custodian fixture',$5,'SCOPED')",
        [override, org, custodianMembership, permission, actor],
      );
      await db.query(
        "INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)",
        [org, override, scope],
      );
    }
  });
  const custodySource = await freshSource(),
    custodySettlement = await settleSource(custodySource);
  const custodyVoucher = ok(
    await rpc("create_reservation_refund_pending_v1", {
      p_input: {
        ...input,
        sourceVoucherId: custodySource.id,
        settlementId: custodySettlement.id,
        basisFingerprint: custodySource.preview.fingerprint,
        idempotencyKey: key + "-custodian-pending",
      },
    }),
  ).voucherId;
  const custodyBase = {
    ...baseAction,
    sourceVoucherId: custodySource.id,
    settlementId: custodySettlement.id,
    basisFingerprint: custodySource.preview.fingerprint,
    voucherId: custodyVoucher,
  };
  let custodyRow = (
    await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [
      custodyVoucher,
    ])
  ).rows[0];
  ok(
    await action({
      ...custodyBase,
      expectedReviewVersion: Number(custodyRow.review_version),
      expectedApprovalVersion: Number(custodyRow.approval_version),
      expectedPostingVersion: Number(custodyRow.posting_version),
      action: "approve",
      idempotencyKey: key + "-custodian-approve",
    }),
  );
  custodyRow = (
    await db.query("SELECT * FROM public.income_expenses WHERE id=$1", [
      custodyVoucher,
    ])
  ).rows[0];
  const custodyPost = {
    ...custodyBase,
    expectedReviewVersion: Number(custodyRow.review_version),
    expectedApprovalVersion: Number(custodyRow.approval_version),
    expectedPostingVersion: Number(custodyRow.posting_version),
    action: "post",
    cashbookId: account,
    postedOn: today,
    evidenceIds: [await evidence()],
    idempotencyKey: key + "-independent-custodian",
  };
  assert.equal(
    (await action(custodyPost, custodianActor)).status,
    403,
    "viewer without actual custody cannot post",
  );
  await fixture(() =>
    db.query(
      "UPDATE public.cashbook_possession_bindings SET membership_id=$2 WHERE organization_id=$1",
      [org, custodianMembership],
    ),
  );
  const beforeCustodian = await cash();
  ok(await action(custodyPost, custodianActor));
  assert.equal(
    await cash(),
    beforeCustodian - 100,
    "separate non-maker custodian with view-only permissions can post",
  );
  console.log(
    "PASS distinct non-maker custodian JWT: no approve/deposits.refund/edit permission, exact custody required.",
  );
  assert.equal((await action({...baseAction,organizationId:otherOrg,action:'approve',idempotencyKey:key+'-cross-org'})).status,403,'cross-org source/action rejected before replay or CAS');
  const parseRef = {
    kind: "reservation_refund",
    organizationId: org,
    sourceVoucherId: deposit,
    settlementId: settlement.id,
    refundVoucherId: v.id,
  };
  const parsed = domain.parseReservationRefundSource(
    ok(await readWorkflow()),
    parseRef,
    actor,
  );
  const rawSnapshot = ok(
    await rpc("read_income_expense_action_snapshots_v1", {
      p_organization_id: org,
      p_voucher_ids: [v.id],
    }),
  );
  const batch = snapshots.parseActionSnapshotBatch(
    rawSnapshot,
    { organizationId: org, actorId: actor },
    [v.id],
  );
  assert.ok(
    batch.rows[v.id]?.capabilities.reservationRefund,
    JSON.stringify(batch.unavailable),
  );
  assert.equal(
    (
      await domain.verifyReservationRefundExisting(parsed, {
        readVoucher: async () => batch.rows[v.id],
      })
    ).voucherId,
    v.id,
  );
  assert.equal(
    (
      await action(
        {
          ...baseAction,
          action: "resubmit",
          idempotencyKey: key + "-other-maker",
        },
        custodianActor,
      )
    ).status,
    403,
    "non-maker resubmit denied despite visible source",
  );
  console.log(
    "PASS actual reader JSON through production TS parsers/source identity adapter; non-maker resubmit denial",
  );
} finally {
  await fixture(async () => {
    await db.query(
      "DELETE FROM app_private.server_feature_flag_canary_orgs WHERE organization_id=$1",
      [org],
    );
    await db.query(
      "DELETE FROM app_private.server_feature_flags WHERE feature_key=ANY($1::text[])",
      [seededFlags],
    );
    for (const table of [
      "income_expense_flow_ownership",
      "canonical_write_operations",
      "reservation_refund_operations",
      "reservation_settlement_write_tokens",
      "storage_object_links",
    ])
      await db.query(
        "DELETE FROM app_private." +
          table +
          " WHERE " +
          (table === "reservation_settlement_write_tokens" ||
          table === "reservation_refund_operations"
            ? "settlement_id IN (SELECT id FROM public.reservation_deposit_settlements WHERE organization_id=$1)"
            : "organization_id=$1"),
        [org],
      );
    const tables = (
      await db.query(
        "SELECT n.nspname schema,c.relname name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='organization_id' AND NOT a.attisdropped WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p')",
      )
    ).rows;
    for (const t of tables)
      await db.query(
        'DELETE FROM "' +
          t.schema.replaceAll('"', '""') +
          '"."' +
          t.name.replaceAll('"', '""') +
          '" WHERE organization_id=ANY($1::uuid[])',
        [[org, otherOrg]],
      );
    await db.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [
      [actor, outsider, custodianActor],
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
