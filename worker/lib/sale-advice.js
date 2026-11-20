const fold = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll('đ', 'd');
const words = (value) =>
  fold(value)
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim();
const contains = (text, phrase) => (' ' + text + ' ').includes(' ' + phrase + ' ');
const vnMoney = (value) => Math.round(value).toLocaleString('vi-VN');
const smallNumbers = ['nhat', 'hai', 'ba'];

export function saleQuestionKind(text) {
  const s = words(text);
  if (
    !s ||
    s.length > 1000 ||
    /\b(da chot|da thue|cam on|da gui|da xem xong)\b/.test(s) ||
    /\b(hoa don|hop dong|thanh toan|dat coc|chuyen khoan|khieu nai|hoan tien|ai dang o|ai o phong|cccd|cong no|tao phieu|xoa|sua gia|sua phong|ghi chu sale|doi gia)\b/.test(
      s,
    )
  )
    return null;
  if (/^(?:p\.?\s*)?\d+[a-z]?$/i.test(s) || /^toa\s+\S/.test(s)) return 'followup';
  if (
    /\b(bang phong|danh sach phong|bang hom nay|gui bang|anh bang|phong trong|phong pass|phong sap trong|tim phong|tu van phong|tu van can|tim can|kiem phong|can thue|can phong|con phong|con can|xem phong|phong nao|can nao|gia phong|anh phong|thong tin (phong|can)|phong [a-z]?\d+|studio|chung cu mini)\b/.test(
      s,
    ) ||
    (/\b\d+(?:tr|trieu|k)\d*\b/.test(s.replace(/(\d) (trieu|tr|k)\b/g, '$1$2')) &&
      /\b(phong|can|duoi|tam|quanh|ngan sach)\b/.test(s))
  )
    return 'question';
  if (
    /\b(re hon|can khac|phong khac|can nay|phong nay|can do|phong do|gui anh|xem anh|hinh anh|khuyen mai|uu dai|chinh sach|tien dien|tien nuoc|phi dich vu|pdv|dien nuoc|may lanh|ban cong|vao o|can thu|phong thu|can so|phong so|co anh)\b/.test(
      s,
    ) ||
    /^\d+(?:[.,]\d+)?\s*(?:tr(?:ieu)?|k)\d*(?: thoi)?$/.test(fold(text).trim())
  )
    return 'followup';
  return null;
}

const feeNames = [
  ['Điện', /\b(?:gia |tien )?dien\b/],
  ['Nước', /\b(?:gia |tien )?nuoc\b/],
  ['PDV', /\b(?:phi dich vu|pdv)\b/],
];
function shortTariff(value) {
  return value
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\b(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:đồng|vnd|đ)?(?=\s|\/|$)/giu, (_, amount) => {
      const vnd = Number(amount.replace(/[.,]/g, ''));
      const fraction = String(vnd % 1000)
        .padStart(3, '0')
        .replace(/0+$/, '');
      return Math.floor(vnd / 1000) + 'k' + fraction;
    });
}
function feeParts(policy) {
  const clauses = String(policy || '').split(/[\n;|·]+|,\s*(?=(?:giá |tiền )?(?:điện|nước|phí dịch vụ|pdv)\b)/iu);
  const rest = [];
  const amounts = feeNames.map(() => []);
  for (const clause of clauses.map((value) => value.trim()).filter(Boolean)) {
    const indexes = feeNames.flatMap(([, re], i) => (re.test(fold(clause)) ? [i] : []));
    if (!indexes.length || !/\d|mien phi|free|da bao gom/i.test(fold(clause))) {
      rest.push(clause);
      continue;
    }
    if (indexes.length > 1) {
      rest.push(clause);
      continue;
    }
    const i = indexes[0];
    const pos = fold(clause).match(feeNames[i][1]);
    // Preserve qualifiers and alternative tariffs written by the publisher.
    if (pos.index > 2) {
      rest.push(clause);
      continue;
    }
    amounts[i].push(clause.slice(pos.index + pos[0].length).replace(/^[\s:–=-]+/u, ''));
  }
  return { amounts, rest };
}
function fees(room, building) {
  const own = feeParts([room.baseNote, room.status === 'pass' && room.passSalePolicy].filter(Boolean).join('\n'));
  const common = feeParts(building.salePolicy);
  const rest = [...own.rest, ...common.rest];
  const line = feeNames
    .map(([label, pattern], i) => {
      const values = own.amounts[i].length ? own.amounts[i] : common.amounts[i];
      if (values.length) return label + ' ' + [...new Set(values.map(shortTariff))].join(' / ');
      if (rest.some((clause) => pattern.test(fold(clause)))) return label + ' cần xác nhận';
      if (i === 0 && Number.isFinite(building.elecRate) && building.elecRate > 0)
        return label + ' ' + shortTariff(String(building.elecRate)) + '/kWh';
      return label + ' chưa cập nhật';
    })
    .join(' · ');
  return { line, rest };
}

function roomCard(room, building, link, viewingPhone) {
  const unit = room.area > 0 ? room.area + 'm²' : '';
  const { line, rest } = fees(room, building);
  const phone =
    (room.status === 'pass' && !room.passContactManager && room.passContactPhone?.trim()) || viewingPhone;
  const policy = [...new Set(rest.filter(Boolean))].join(' · ');
  return [
    'Phòng ' + room.code + ' · ' + building.name,
    building.address,
    [room.price > 0 ? vnMoney(room.price * 1e6) + 'đ/tháng' : 'Giá chưa cập nhật', unit, room.type]
      .filter(Boolean)
      .join(' · '),
    [room.saleFact.label, room.status === 'pass' && room.passAvailDate && 'ngày vào ' + room.passAvailDate]
      .filter(Boolean)
      .join(' · '),
    room.amenities.length && 'Nội thất: ' + room.amenities.join(', '),
    room.description,
    !room.images.some((url) => !/[.]mp4(?:$|[?#])/i.test(url)) && 'Ảnh căn: chưa cập nhật',
    policy && 'Chính sách: ' + policy,
    line,
    room.promotion &&
      'Khuyến mãi: ' +
        room.promotion +
        (room.promotionEndsAt
          ? ' (đến ' +
            new Intl.DateTimeFormat('vi-VN', {
              timeZone: 'Asia/Ho_Chi_Minh',
              dateStyle: 'short',
              timeStyle: 'short',
            }).format(new Date(room.promotionEndsAt)) +
            ')'
          : ''),
    'Xem tin phòng trống tại ' + link,
    phone ? 'Để hẹn giờ xem phòng, nhắn Zalo hoặc gọi ' + phone + '.' : 'Số hẹn xem phòng chưa cập nhật.',
  ]
    .filter(Boolean)
    .join('\n');
}

function budget(text) {
  const values = [...fold(text).matchAll(/(\d+(?:[.,]\d+)?)\s*(tr(?:ieu)?|k)(\d*)/g)].map(
    (m) =>
      Number(m[1].replace(',', '.')) * (m[2] === 'k' ? 1000 : 1e6) +
      (m[3] ? Number('0.' + m[3]) * (m[2] === 'k' ? 1000 : 1e6) : 0),
  );
  if (!values.length) return {};
  if (values.length > 1) return { min: Math.min(...values), max: Math.max(...values) };
  return /\b(tu|it nhat|tren)\s+\d/.test(fold(text))
    ? { min: values[0] }
    : { max: values[0], exclusive: /\bduoi\b/.test(words(text)) };
}

function moveIn(text, today) {
  const s = fold(text);
  if (/\b(vao ngay|o ngay|trong ngay|hom nay)\b/.test(s)) return today;
  const d = new Date(today + 'T00:00:00Z');
  if (/\b(thang sau|thang toi)\b/.test(s))
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  if (/\b(tuan sau|ngay mai)\b/.test(s)) {
    d.setUTCDate(d.getUTCDate() + (s.includes('ngay mai') ? 1 : 8 - (d.getUTCDay() || 7)));
    return d.toISOString().slice(0, 10);
  }
  const m = s.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b/);
  if (!m) return null;
  const iso = [m[3] || today.slice(0, 4), m[2].padStart(2, '0'), m[1].padStart(2, '0')].join('-');
  const date = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().startsWith(iso) ? iso : 'invalid';
}

export function adviseSale({ question, previous, buildings, link, today, viewingPhone }) {
  const reply = (text) => ({ messages: [{ text }], memory: previous || {} });
  if (!link || !buildings) return reply('Trang Sale Phòng chưa có link đang đăng để tra cứu.');
  const rows = buildings.flatMap((building) => building.rooms.map((room) => ({ room, building })));
  const s = words(question);
  if (/\b(bang phong|bang hom nay|gui bang|anh bang|danh sach day du)\b/.test(s))
    return { messages: [{ text: 'Bảng phòng trống hiện tại: ' + link, table: true }], memory: previous || {} };
  const old = previous || {};
  const explicitCode = s.match(/\b(?:phong|can|p)\s*([a-z]?\d+[a-z]?)\b/)?.[1];
  const ordinal = s.match(/\b(?:can|phong|cai)\s+(?:thu|so)\s+(nhat|hai|ba|mot|[123])\b/)?.[1];
  const index =
    ordinal && (ordinal === 'mot' ? 0 : Number(ordinal) ? Number(ordinal) - 1 : smallNumbers.indexOf(ordinal));
  const selection =
    ordinal ||
    /\b(can nay|can do|phong do|phong nay|gui anh|xem anh|uu dai|khuyen mai|chinh sach|tien dien|tien nuoc|pdv)\b/.test(
      s,
    );
  let picked;
  if (!explicitCode && selection) {
    if (!ordinal && old.ids?.length !== 1)
      return reply('Sale muốn xem căn nào? Cho mình mã phòng kèm tên tòa hoặc số thứ tự trong danh sách vừa gửi.');
    picked = old.ids?.[ordinal ? index : 0];
    if (!picked) return reply('Cho mình mã phòng và tên tòa để lấy đúng tin đang đăng nhé.');
    if (!rows.some(({ room }) => room.id === picked)) return reply('Căn vừa chọn đã gỡ khỏi trang Sale Phòng.');
  }
  const follow = saleQuestionKind(question) === 'followup' || /\b(re hon|khac)\b/.test(s);
  const criteria = follow ? { ...old.criteria } : {};
  const money = budget(question);
  if (Object.keys(money).length) {
    delete criteria.min;
    delete criteria.max;
    delete criteria.exclusive;
    Object.assign(criteria, money);
  }
  const date = moveIn(question, today);
  if (date === 'invalid') return reply('Sale cho mình ngày vào ở theo dạng ngày/tháng nhé.');
  if (date) criteria.date = date;
  if (contains(s, 'phong pass') || contains(s, 'can pass')) criteria.status = 'pass';
  if (contains(s, 'sap trong')) criteria.status = 'soon';
  const locations = buildings
    .flatMap((b) => [b.name, b.area, b.district, ...String(b.address || '').split(',')])
    .filter(Boolean)
    .flatMap((label) => [words(label), words(label).replace(/^(quan|huyen|phuong|toa) /, '')])
    .filter((x) => x.length > 1);
  const place = locations.filter((x) => x !== 'khac' && contains(s, x)).sort((a, b) => b.length - a.length)[0];
  if (place) criteria.place = place;
  const areaRequested = fold(question).match(
    /(?:khu vuc|tai quan|o quan|khu|tai|quan)\s+([^,?;.!]+?)(?=\s+(?:gia|duoi|tu |co |vao |ngan sach|con |khong|tam )|[,?;.!]|$)/,
  );
  if (!place && areaRequested) criteria.place = words(areaRequested[1]);
  const leadingArea = s.match(/^(.+?)\s+(?:duoi|tam|ngan sach|gia tu)\b/)?.[1];
  if (!place && !areaRequested && leadingArea && !/\b(phong|can|tim|khach|ngan sach)\b/.test(leadingArea))
    criteria.place = leadingArea;
  const amenities = [
    ['may lanh', 'dieu hoa'],
    ['ban cong'],
    ['thang may'],
    ['may giat'],
    ['gac'],
    ['cua so'],
    ['studio'],
    ['noi that day du', 'full noi that'],
  ];
  const requested = amenities.filter((group) => group.some((x) => contains(s, x)));
  if (requested.length)
    criteria.amenities = [...new Set([...(criteria.amenities || []), ...requested.map((x) => x[0])])];
  const rawCode = explicitCode || s.match(/^\s*([a-z]?\d+[a-z]?)\s*$/)?.[1];
  if (rawCode) {
    delete criteria.code;
  }
  let matches = rows.filter(({ room: r, building: b }) => {
    if (picked) return r.id === picked;
    if (rawCode && words(r.code) !== rawCode) return false;
    if (criteria.status && r.status !== criteria.status) return false;
    const loc = words([b.name, b.area, b.address].join(' '));
    if (criteria.place && !contains(loc, criteria.place)) return false;
    const price = Math.round(r.price * 1e6);
    if (
      ((criteria.min || criteria.max) && !price) ||
      (criteria.min && price < criteria.min) ||
      (criteria.max && (criteria.exclusive ? price >= criteria.max : price > criteria.max))
    )
      return false;
    if (
      criteria.date &&
      r.saleFact.kind !== 'ready' &&
      (!(r.passDate || r.saleFact.availableOn) || (r.passDate || r.saleFact.availableOn) > criteria.date)
    )
      return false;
    const facts = words([r.type, ...r.amenities, r.description, b.liftLabel].filter(Boolean).join(' '));
    return (criteria.amenities || []).every((key) =>
      amenities.find((group) => group[0] === key)?.some((x) => contains(facts, x)),
    );
  });
  if (!picked && /\b(re hon|khac)\b/.test(s)) {
    matches = matches.filter(
      ({ room: r }) =>
        !old.ids?.includes(r.id) &&
        (!s.includes('re hon') || !old.lowest || (r.price > 0 && r.price < old.lowest)),
    );
  }
  if (rawCode && matches.length > 1)
    return {
      messages: [
        {
          text:
            'Phòng ' +
            rawCode.toUpperCase() +
            ' có ở ' +
            matches.map((x) => x.building.name).join(', ') +
            '. Sale muốn xem tòa nào?',
        },
      ],
      memory: { criteria: { ...criteria, code: rawCode }, ids: matches.map((x) => x.room.id).slice(0, 3) },
    };
  if (criteria.code && !rawCode) matches = matches.filter((x) => words(x.room.code) === criteria.code);
  matches.sort(
    (a, b) =>
      Number(b.room.saleFact.kind === 'ready') - Number(a.room.saleFact.kind === 'ready') ||
      (a.room.price || Infinity) - (b.room.price || Infinity) ||
      String(a.room.id).localeCompare(String(b.room.id)),
  );
  const selected = matches.slice(0, 3);
  if (!selected.length)
    return {
      messages: [
        { text: 'Chưa có căn đang đăng khớp nhu cầu này. Sale muốn đổi khu vực, ngày vào hoặc mức giá nào?' },
      ],
      memory: { criteria, ids: [] },
    };
  return {
    messages: selected.map(({ room, building }) => ({ text: roomCard(room, building, link, viewingPhone), room })),
    memory: {
      criteria,
      ids: selected.map((x) => x.room.id),
      lowest:
        selected
          .map((x) => x.room.price)
          .filter(Boolean)
          .sort((a, b) => a - b)[0] || null,
    },
  };
}
