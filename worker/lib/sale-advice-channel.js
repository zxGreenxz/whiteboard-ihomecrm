import { sb } from './ctx.js';
import { isHermesLinkMessage } from './hermes-link.js';
import { saleQuestionKind, adviseSale } from './sale-advice.js';
import { chuanHoaAutoReply } from './automation-config.js';
import { mapPayloadSangToa } from './vacant-rooms.js';
import { chuanBiAnhPhong } from './automation-room-image.js';
import { downloadAttachment } from './media.js';
import { buildRoomListTable } from './room-list-table.js';

const uid = (value) => typeof value === 'string' && /^[1-9]\d{0,39}$/.test(value);

// Called exclusively from the live message listener, before native DM capture.
// Never pass attachments, quote text, link handshakes or self echoes as questions.
export async function captureSaleQuestion(event, source, db = sb) {
  const d = event?.data;
  if (
    !source ||
    ![0, 1].includes(event?.type) ||
    event.isSelf !== false ||
    d?.msgType !== 'webchat' ||
    typeof d.content !== 'string' ||
    d.content.length > 1000 ||
    isHermesLinkMessage(event) ||
    !uid(event.threadId) ||
    !uid(d.uidFrom) ||
    d.uidFrom === source.ownUid ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(String(d.msgId || '')) ||
    !Number.isSafeInteger(Number(d.ts)) ||
    [event, d].some((v) => v.forward || v.isForward || v.fw) ||
    (event.type === 0 && (event.threadId !== d.uidFrom || d.idTo !== source.ownUid))
  )
    return false;
  const kind = saleQuestionKind(d.content);
  if (!kind) return false;
  const { data, error } = await db.rpc('zalo_sale_advice_intake_v1', {
    p: {
      organizationId: source.organizationId,
      accountId: source.accountId,
      instanceId: source.instanceId,
      generation: source.generation,
      threadId: event.threadId,
      threadType: event.type === 0 ? 'user' : 'group',
      senderUid: d.uidFrom,
      messageId: String(d.msgId),
      sentAt: Number(d.ts),
      question: d.content,
      followUp: kind === 'followup',
    },
  });
  // Older databases cannot have accepted a job when PostgREST has no such RPC.
  if (error?.code === 'PGRST202') return false;
  if (error) throw new Error('sale_advice_intake_unavailable');
  return ['queued', 'duplicate', 'limited', 'blocked'].includes(data);
}

export function salePageBuildings(page) {
  if (!page) return null;
  const rows = new Map(page.rooms.map((r) => [r.id, r]));
  return mapPayloadSangToa(page).map((b) => ({
    ...b,
    rooms: b.rooms
      .filter((r) => ['free', 'soon', 'pass'].includes(r.status))
      .map((r) => {
        const row = rows.get(r.id);
        return {
          ...r,
          baseNote: row.sale_note_base ?? (row.active_policy_text ? '' : row.sale_note),
          promotion: row.active_policy_text,
          promotionEndsAt: row.active_policy_ends_at,
          passDate: row.pass_avail_date,
        };
      }),
  }));
}

async function roomAttachments(room, job) {
  const images = room.images.filter((url) => !/[.]mp4(?:$|[?#])/i.test(url));
  const refs = await chuanBiAnhPhong(
    { ...room, images },
    { accountId: job.account_id, orgId: job.organization_id },
  );
  const attachments = [];
  for (const ref of refs) attachments.push(await downloadAttachment(ref));
  return attachments;
}

async function tableAttachment(buildings) {
  const table = buildRoomListTable(buildings);
  if (!table.totalRooms) return [];
  const { veBangRaCanvas, napFont, tenTepAnh } = await import('./room-list-image.js');
  napFont();
  const canvas = veBangRaCanvas(table);
  const data = canvas.toBuffer('image/png');
  return [
    {
      data,
      filename: tenTepAnh(),
      metadata: { totalSize: data.length, width: canvas.width, height: canvas.height },
    },
  ];
}

// The normal worker owns claim, timeout, success and unknown-effect handling.
// Each send is fenced again using the live Sale snapshot and current membership.
export async function deliverSaleAdvice(
  job,
  source,
  send,
  { db = sb, photos = roomAttachments, table = tableAttachment } = {},
) {
  if (!source || source.organizationId !== job.organization_id || source.accountId !== job.account_id)
    throw new Error('sale_advice_session_changed');
  const read = async (signature = null, memory = null) => {
    const { data, error } = await db.rpc('zalo_sale_advice_delivery_v1', {
      p_job: job.id,
      p_instance: source.instanceId,
      p_generation: source.generation,
      p_signature: signature,
      p_memory: memory,
    });
    if (error || !data) throw new Error('sale_advice_not_admitted');
    return data;
  };
  const snapshot = await read();
  const blocked = chuanHoaAutoReply({ blockedKeywords: snapshot.blockedKeywords }).blockedKeywords;
  if (blocked.some((word) => snapshot.question.toLowerCase().includes(word))) return;
  const buildings = salePageBuildings(snapshot.page);
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const plan = adviseSale({ ...snapshot, buildings, today });
  async function sendPart(text, attachments) {
    const recipient = await read(snapshot.signature, plan.memory);
    if (
      recipient.authorized !== true ||
      !uid(recipient.threadId) ||
      !['group', 'user'].includes(recipient.threadType)
    )
      throw new Error('sale_advice_recipient_changed');
    const payload = attachments.length ? { msg: text, attachments } : { msg: text };
    const result = await send(payload, recipient.threadId, recipient.threadType === 'group' ? 1 : 0);
    if (!(result?.message?.msgId || result?.msgId || result?.attachment?.some((a) => a.msgId)))
      throw new Error('sale_advice_receipt_unknown');
  }
  for (const message of plan.messages) {
    if (!message.room) {
      await sendPart(message.text, message.table ? await table(buildings) : []);
      continue;
    }
    const images = message.room.images.filter((url) => !/[.]mp4(?:$|[?#])/i.test(url));
    for (let i = 0; i < Math.max(1, images.length); i += 12) {
      const room = { ...message.room, images: images.slice(i, i + 12) };
      let attachments;
      try {
        attachments = await photos(room, job);
      } catch {
        await sendPart('Chưa tải được ảnh căn.\n' + message.text, []);
        break;
      }
      const text = i + 12 >= images.length ? message.text : 'Ảnh phòng ' + room.code + ' · ' + room.buildingName;
      await sendPart(text, attachments);
    }
  }
}
