"""Build CT01 + lease; keep source sizes except four 10pt signature dates.

Run with the bundled document Python (lxml). References contain only blank forms.
The lease uses Times New Roman per the user's explicit follow-up. Its Normal
style and numbering are namespaced so the two source documents do not collide.
"""
from copy import deepcopy
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as ET
import re

ROOT = Path(__file__).resolve().parent.parent
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
NS = {'w': W[1:-1]}


def xml(data):
    return ET.fromstring(data)


def serialize(node):
    return ET.tostring(node, encoding='UTF-8', xml_declaration=True, standalone=True)


def text(node):
    return ''.join(node.itertext())


def fill(p, value, start=0, end=None):
    runs = p.findall('w:r', NS)[start:end]
    run = deepcopy(runs[0])
    for child in list(run):
        if child.tag != W + 'rPr':
            run.remove(child)
    t = ET.SubElement(run, W + 't')
    t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
    t.text = value
    p.insert(p.index(runs[0]), run)
    for old in runs:
        p.remove(old)


def replace_span(p, start, end, value):
    """Replace text across source runs, retaining the original slot's rPr."""
    offset = 0
    inserted = False
    for t in p.iter(W + 't'):
        original = t.text or ''
        next_offset = offset + len(original)
        if offset < end and next_offset > start:
            before = original[:max(0, start - offset)]
            after = original[max(0, end - offset):]
            t.text = before + (value if not inserted else '') + after
            t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
            inserted = True
        offset = next_offset
    assert inserted


with ZipFile(ROOT / 'scripts/fixtures/ct01/ct01-source.docx') as z:
    parts = {i.filename: z.read(i.filename) for i in z.infolist()}
with ZipFile(ROOT / 'scripts/fixtures/ct01/lease-source.docx') as z:
    lease_parts = {i.filename: z.read(i.filename) for i in z.infolist()}

doc = xml(parts['word/document.xml'])
body = doc.find('w:body', NS)
p = body.findall('w:p', NS)
tables = body.findall('w:tbl', NS)
assert len(tables) == 4 and len(p) == 17
fill(p[6], '{registration_authority}', 4)
fill(p[7], ' {full_name}', 2)
fill(p[8], ' {date_of_birth}       ', 1, 11)
fill(p[8], ' {gender}', -1)
# Keep 13pt labels and 12pt values from the original phone/email line.
fill(p[9], ' {email}', 10)
fill(p[9], ' {phone}     ', 5, 7)
fill(p[10], ' {household_head_name}   ', 2, 6)
fill(p[11], ' {registration_request}', 3)
# The filled request wraps naturally; the original dotted continuation is blank.
body.remove(p[12])
for table, prefix in [(tables[0], 'id'), (tables[1], 'head_id')]:
    for i, cell in enumerate(table.find('w:tr', NS).findall('w:tc', NS)[1:], 1):
        paragraph = cell.find('w:p', NS)
        if not paragraph.findall('w:r', NS):
            ET.SubElement(paragraph, W + 'r')
        fill(paragraph, '{' + prefix + '_' + str(i) + '}')

for cell in tables[3].find('w:tr', NS).findall('w:tc', NS):
    date_p = cell.find('w:p', NS)
    original = text(date_p)
    for keyword, slot in [('năm', 'year'), ('tháng', 'month'), ('ngày', 'day')]:
        match = re.search(keyword + r'(\.+)', original)
        assert match, original
        replace_span(date_p, match.start(1), match.end(1), ' {signature_' + slot + '} ')
    # No signing locality is supplied; retain the requested date without blank dots.
    locality = re.match(r'\.+,', original)
    if locality:
        replace_span(date_p, locality.start(), locality.end(), '')
    # User permits only these four dates at 10pt so each fits on one line.
    for properties in date_p.iter(W + 'rPr'):
        size = properties.find('w:sz', NS)
        complex_size = properties.find('w:szCs', NS)
        if size is None:
            size = ET.Element(W + 'sz')
            properties.insert(properties.index(complex_size) if complex_size is not None else len(properties), size)
        if complex_size is None:
            complex_size = ET.Element(W + 'szCs')
            properties.insert(properties.index(size) + 1, complex_size)
        size.set(W + 'val', '20')
        complex_size.set(W + 'val', '20')
    # Keep signature label sizes. Remove only surplus blank signature lines.
    for paragraph in cell.findall('w:p', NS)[1:]:
        if not text(paragraph).strip():
            cell.remove(paragraph)
row = tables[3].find('w:tr', NS)
trpr = row.find('w:trPr', NS)
if trpr is None:
    trpr = ET.SubElement(row, W + 'trPr')
height = ET.SubElement(trpr, W + 'trHeight')
height.set(W + 'val', '1400')
height.set(W + 'hRule', 'atLeast')

lease_doc = xml(lease_parts['word/document.xml'])
lease_body = lease_doc.find('w:body', NS)
# The user's replacement reference changes the lease text, retaining 11pt body
# and 14pt title from the source, along with its page settings.
lease_section_source = deepcopy(lease_body.find('w:sectPr', NS))
for child in list(lease_body):
    lease_body.remove(child)


def lease_paragraph(value, *, center=False, bold=False, size=22, before=0, after=0, indent=0):
    paragraph = ET.SubElement(lease_body, W + 'p')
    properties = ET.SubElement(paragraph, W + 'pPr')
    ET.SubElement(properties, W + 'spacing', {W + 'before': str(before), W + 'after': str(after), W + 'line': '240', W + 'lineRule': 'auto'})
    if center:
        ET.SubElement(properties, W + 'jc', {W + 'val': 'center'})
    if indent:
        ET.SubElement(properties, W + 'ind', {W + 'left': str(indent)})
    run = ET.SubElement(paragraph, W + 'r')
    rp = ET.SubElement(run, W + 'rPr')
    ET.SubElement(rp, W + 'rFonts', {W + 'ascii': 'Times New Roman', W + 'hAnsi': 'Times New Roman'})
    if bold:
        ET.SubElement(rp, W + 'b')
    ET.SubElement(rp, W + 'sz', {W + 'val': str(size)})
    ET.SubElement(rp, W + 'szCs', {W + 'val': str(size)})
    ET.SubElement(run, W + 't', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'}).text = value
    return paragraph


lease_paragraph('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', center=True, bold=True, after=160)
lease_paragraph('Độc lập - Tự do - Hạnh Phúc', center=True, after=100)
lease_paragraph('________________________', center=True, after=200)
lease_paragraph('HỢP ĐỒNG CHO THUÊ, MƯỢN, Ở NHỜ', center=True, bold=True, size=28, after=180)
lease_paragraph('Hôm nay, Ngày {signature_day} Tháng {signature_month} Năm {signature_year}, Tại {building_locality}', after=120)
lease_paragraph('1. ĐẠI DIỆN BÊN CHO THUÊ, MƯỢN, Ở NHỜ (Gọi tắt là bên A):', after=100)
lease_paragraph('Ông (Bà): {owner_name}        Sinh Năm: {owner_birth_year}', indent=280)
lease_paragraph('-  CCCD: {owner_id_number}    Ngày cấp: {owner_id_issue_date}    Nơi Cấp: {owner_id_issue_place}')
lease_paragraph('-  Hiện thường trú: {owner_permanent_address}')
lease_paragraph('2. ĐẠI DIỆN BÊN THUÊ, MƯỢN, Ở NHỜ (Gọi tắt là bên B):')
lease_paragraph('Ông (Bà): {full_name}        Sinh năm: {date_of_birth}', indent=280)
lease_paragraph('-  CCCD: {customer_id_number}    Ngày cấp: {customer_id_issue_date}    Nơi cấp: {customer_id_issue_place}')
lease_paragraph('-  Hiện thường trú: {customer_permanent_address}')
lease_paragraph('Bằng hợp đồng này, bên A đồng ý cho bên B thuê, mượn, ở nhờ nhà với những thỏa thuận sau đây:', after=120)
lease_paragraph('3. Đối tượng của hợp đồng này là: Một phần hoặc toàn bộ căn nhà số: {building_address}')
lease_paragraph('Bên cho thuê, mượn, cho ở nhờ là người đứng tên chủ quyền sở hữu nhà ở.', indent=280)
lease_paragraph('4. Mục đích: để ở và đăng ký tạm trú.')
lease_paragraph('Bên A đồng ý cho bên B được thuê, mượn, ở nhờ và đăng ký tạm trú vào địa chỉ căn nhà trên.', indent=280)
lease_paragraph('(kèm theo danh sách số người tạm trú được ghi trên tờ khai thay đổi thông tin cư trú)', indent=280)
lease_paragraph('Thời hạn mượn: {duration_months} tháng (từ {download_date} đến {lease_end_date})', indent=280)
lease_paragraph('5. Bên A và Bên B: cam kết chịu trách nhiệm trước pháp luật về tất cả những thỏa thuận đã ghi trong hợp đồng.')
lease_paragraph('Hợp đồng được lập thành 2 bản, các bản đều giống nhau', indent=280, after=700)
# Two signature columns reproduce the supplied reference without visible borders.
signatures = ET.SubElement(lease_body, W + 'tbl')
tp = ET.SubElement(signatures, W + 'tblPr')
ET.SubElement(tp, W + 'tblW', {W + 'w': '9360', W + 'type': 'dxa'})
ET.SubElement(tp, W + 'tblLayout', {W + 'type': 'fixed'})
borders = ET.SubElement(tp, W + 'tblBorders')
for edge in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']:
    ET.SubElement(borders, W + edge, {W + 'val': 'nil'})
grid = ET.SubElement(signatures, W + 'tblGrid')
for _ in range(2):
    ET.SubElement(grid, W + 'gridCol', {W + 'w': '4680'})
row = ET.SubElement(signatures, W + 'tr')
for heading, party in [('Bên cho thuê, mượn nhà ở', '(Bên A)'), ('Bên thuê, mượn nhà ở nhờ', '(Bên B)')]:
    cell = ET.SubElement(row, W + 'tc')
    cp = ET.SubElement(cell, W + 'tcPr')
    ET.SubElement(cp, W + 'tcW', {W + 'w': '4680', W + 'type': 'dxa'})
    for value in [heading, party, '(ký và ghi rõ họ tên)']:
        cell.append(lease_paragraph(value, center=True, after=160))
lease_paragraph('')
lease_body.append(lease_section_source)

# Isolate source styles, including default 11pt run settings inherited by lease.
styles = xml(parts['word/styles.xml'])
lease_styles = xml(lease_parts['word/styles.xml'])
style_map = {s.get(W + 'styleId'): 'Lease' + s.get(W + 'styleId') for s in lease_styles.findall('w:style', NS)}
for s in lease_styles.findall('w:style', NS):
    old_id = s.get(W + 'styleId')
    s.set(W + 'styleId', style_map[old_id])
    s.attrib.pop(W + 'default', None)
    s.find('w:name', NS).set(W + 'val', 'Lease ' + s.find('w:name', NS).get(W + 'val'))
    for tag in ['basedOn', 'next', 'link']:
        for ref in s.findall('w:' + tag, NS):
            ref.set(W + 'val', style_map.get(ref.get(W + 'val'), ref.get(W + 'val')))
    if old_id == 'Normal':
        defaults = lease_styles.find('w:docDefaults', NS)
        for kind, path in [('pPr', 'w:pPrDefault/w:pPr'), ('rPr', 'w:rPrDefault/w:rPr')]:
            if s.find('w:' + kind, NS) is None:
                s.append(deepcopy(defaults.find(path, NS)))
    styles.append(s)

for paragraph in lease_body.iter(W + 'p'):
    ppr = paragraph.find('w:pPr', NS)
    if ppr is None:
        ppr = ET.Element(W + 'pPr')
        paragraph.insert(0, ppr)
    pstyle = ppr.find('w:pStyle', NS)
    if pstyle is None:
        pstyle = ET.Element(W + 'pStyle')
        pstyle.set(W + 'val', 'Normal')
        ppr.insert(0, pstyle)
    pstyle.set(W + 'val', style_map[pstyle.get(W + 'val')])

numbering = xml(lease_parts['word/numbering.xml'])
for ref in numbering.iter(W + 'pStyle'):
    ref.set(W + 'val', style_map.get(ref.get(W + 'val'), ref.get(W + 'val')))

# Explicit user instruction changes only the lease typeface, never w:sz/w:szCs.
for tree in [lease_body, lease_styles, numbering]:
    for font in tree.iter(W + 'rFonts'):
        for attr in list(font.attrib):
            if attr.lower().endswith('theme'):
                del font.attrib[attr]
        for attr in ['ascii', 'hAnsi', 'eastAsia', 'cs']:
            font.set(W + attr, 'Times New Roman')
# styles nodes were moved to the main tree, so update the imported styles too.
for s in styles.findall('w:style', NS):
    if s.get(W + 'styleId', '').startswith('Lease'):
        for font in s.iter(W + 'rFonts'):
            for attr in list(font.attrib):
                if attr.lower().endswith('theme'):
                    del font.attrib[attr]
            for attr in ['ascii', 'hAnsi', 'eastAsia', 'cs']:
                font.set(W + attr, 'Times New Roman')

# End the CT01 section on the last existing paragraph; next section starts page 2.
section = body.find('w:sectPr', NS)
body.remove(section)
last = body[-1]
assert last.tag == W + 'p'
ppr = last.find('w:pPr', NS)
if ppr is None:
    ppr = ET.SubElement(last, W + 'pPr')
section_type = section.find('w:type', NS)
if section_type is None:
    section_type = ET.SubElement(section, W + 'type')
section_type.set(W + 'val', 'nextPage')
ppr.append(section)
for child in lease_body:
    body.append(deepcopy(child))

# Lease has no header in the reference. Explicitly unlink CT01's page-number header.
lease_section = body.find('w:sectPr', NS)
for header_type in ['default', 'first', 'even']:
    header = ET.Element(W + 'headerReference')
    header.set(W + 'type', header_type)
    header.set(R + 'id', 'rIdLeaseHeader')
    lease_section.insert(0, header)

rels = xml(parts['word/_rels/document.xml.rels'])
rel_ns = '{http://schemas.openxmlformats.org/package/2006/relationships}'
ET.SubElement(rels, rel_ns + 'Relationship', Id='rIdLeaseNumbering', Type=R[1:-1] + '/numbering', Target='numbering.xml')
ET.SubElement(rels, rel_ns + 'Relationship', Id='rIdLeaseHeader', Type=R[1:-1] + '/header', Target='lease-header.xml')
content_types = xml(parts['[Content_Types].xml'])
ET.SubElement(content_types, '{http://schemas.openxmlformats.org/package/2006/content-types}Override', PartName='/word/numbering.xml', ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml')
ET.SubElement(content_types, '{http://schemas.openxmlformats.org/package/2006/content-types}Override', PartName='/word/lease-header.xml', ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml')
parts.update({
    'word/document.xml': serialize(doc), 'word/styles.xml': serialize(styles),
    'word/numbering.xml': serialize(numbering), 'word/_rels/document.xml.rels': serialize(rels),
    '[Content_Types].xml': serialize(content_types),
    'word/lease-header.xml': f'<w:hdr xmlns:w="{W[1:-1]}"><w:p/></w:hdr>'.encode(),
})
target = ROOT / 'public/templates/ct01.docx'
with ZipFile(target, 'w', ZIP_DEFLATED) as z:
    for name, data in parts.items():
        z.writestr(name, data)
print(target)
