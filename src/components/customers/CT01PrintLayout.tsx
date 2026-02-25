import React from 'react';
import type { CT01FormValues } from '@/lib/ct01Validation';

interface CT01PrintLayoutProps {
  data: CT01FormValues;
  declarationCode?: string;
}

const printStyles = `
  @media print {
    body * {
      visibility: hidden;
    }
    #ct01-print-layout,
    #ct01-print-layout * {
      visibility: visible;
    }
    #ct01-print-layout {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
    }
  }
`;

const CT01PrintLayout = React.forwardRef<HTMLDivElement, CT01PrintLayoutProps>(
  ({ data, declarationCode }, ref) => {
    return (
      <>
        <style>{printStyles}</style>
        <div
          id="ct01-print-layout"
          ref={ref}
          style={{
            display: 'none',
            fontFamily: 'Times New Roman, serif',
            fontSize: '13px',
            color: '#000',
            backgroundColor: '#fff',
            padding: '20mm 20mm 20mm 25mm',
            width: '210mm',
            minHeight: '297mm',
            boxSizing: 'border-box',
            lineHeight: '1.5',
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ textAlign: 'center', width: '45%' }}>
              <div style={{ fontWeight: 'bold', fontSize: '12px' }}>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
              <div style={{ fontSize: '12px' }}>Độc lập - Tự do - Hạnh phúc</div>
              <div style={{ borderBottom: '1px solid #000', width: '60%', margin: '2px auto' }} />
            </div>
            <div style={{ textAlign: 'right', fontSize: '12px' }}>
              <div>Mẫu CT01</div>
              {declarationCode && <div>Số: {declarationCode}</div>}
            </div>
          </div>

          {/* Title */}
          <div style={{ textAlign: 'center', margin: '16px 0 12px' }}>
            <div style={{ fontWeight: 'bold', fontSize: '15px', textTransform: 'uppercase' }}>
              TỜ KHAI THAY ĐỔI THÔNG TIN CƯ TRÚ
            </div>
          </div>

          {/* Kính gửi */}
          <div style={{ marginBottom: '12px' }}>
            <span style={{ fontStyle: 'italic' }}>Kính gửi: </span>
            <span style={{ fontWeight: 'bold' }}>{data.registration_authority || '...................................'}</span>
          </div>

          {/* Personal Info Section */}
          <div style={{ marginBottom: '4px', fontWeight: 'bold' }}>I. THÔNG TIN CÁ NHÂN</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px', fontSize: '12px' }}>
            <tbody>
              <tr>
                <td style={tdLabelStyle}>Họ và tên:</td>
                <td style={tdValueStyle}>{data.full_name}</td>
                <td style={tdLabelStyle}>Ngày sinh:</td>
                <td style={tdValueStyle}>{data.date_of_birth}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Giới tính:</td>
                <td style={tdValueStyle}>{data.gender}</td>
                <td style={tdLabelStyle}>Số CMND/CCCD:</td>
                <td style={tdValueStyle}>{data.id_number}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Điện thoại:</td>
                <td style={tdValueStyle}>{data.phone || ''}</td>
                <td style={tdLabelStyle}>Email:</td>
                <td style={tdValueStyle}>{data.email || ''}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Nghề nghiệp/Nơi làm việc:</td>
                <td style={{ ...tdValueStyle, colSpan: 3 } as React.CSSProperties} colSpan={3}>{data.occupation_workplace || ''}</td>
              </tr>
            </tbody>
          </table>

          {/* Address Section */}
          <div style={{ marginBottom: '4px', fontWeight: 'bold' }}>II. THÔNG TIN ĐỊA CHỈ</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px', fontSize: '12px' }}>
            <tbody>
              <tr>
                <td style={tdLabelStyle}>Địa chỉ thường trú:</td>
                <td style={{ ...tdValueStyle } as React.CSSProperties} colSpan={3}>{data.permanent_address || ''}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Địa chỉ tạm trú:</td>
                <td style={{ ...tdValueStyle } as React.CSSProperties} colSpan={3}>{data.temporary_address || ''}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Địa chỉ hiện tại:</td>
                <td style={{ ...tdValueStyle } as React.CSSProperties} colSpan={3}>{data.current_address || ''}</td>
              </tr>
            </tbody>
          </table>

          {/* Household Head Section */}
          <div style={{ marginBottom: '4px', fontWeight: 'bold' }}>III. THÔNG TIN CHỦ HỘ</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px', fontSize: '12px' }}>
            <tbody>
              <tr>
                <td style={tdLabelStyle}>Họ tên chủ hộ:</td>
                <td style={tdValueStyle}>{data.household_head_name || ''}</td>
                <td style={tdLabelStyle}>Số CMND/CCCD:</td>
                <td style={tdValueStyle}>{data.household_head_id_number || ''}</td>
              </tr>
              <tr>
                <td style={tdLabelStyle}>Quan hệ với chủ hộ:</td>
                <td style={{ ...tdValueStyle } as React.CSSProperties} colSpan={3}>{data.household_head_relationship || ''}</td>
              </tr>
            </tbody>
          </table>

          {/* Request Content */}
          {data.request_content && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>IV. NỘI DUNG YÊU CẦU</div>
              <div style={{ border: '1px solid #000', padding: '6px', minHeight: '40px', fontSize: '12px' }}>
                {data.request_content}
              </div>
            </div>
          )}

          {/* Family Members Table */}
          {data.family_members && data.family_members.length > 0 && (
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontWeight: 'bold', marginBottom: '6px' }}>
                {data.request_content ? 'V.' : 'IV.'} DANH SÁCH THÀNH VIÊN HỘ GIA ĐÌNH
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f0f0f0' }}>
                    <th style={thStyle}>STT</th>
                    <th style={thStyle}>Họ và tên</th>
                    <th style={thStyle}>Ngày sinh</th>
                    <th style={thStyle}>Giới tính</th>
                    <th style={thStyle}>Số CMND/CCCD</th>
                    <th style={thStyle}>Nghề nghiệp/Nơi làm việc</th>
                    <th style={thStyle}>Quan hệ với người khai</th>
                    <th style={thStyle}>Quan hệ với chủ hộ</th>
                  </tr>
                </thead>
                <tbody>
                  {data.family_members.map((member, index) => (
                    <tr key={index}>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{index + 1}</td>
                      <td style={tdStyle}>{member.full_name}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{member.date_of_birth}</td>
                      <td style={{ ...tdStyle, textAlign: 'center' }}>{member.gender}</td>
                      <td style={tdStyle}>{member.id_number}</td>
                      <td style={tdStyle}>{member.occupation_workplace}</td>
                      <td style={tdStyle}>{member.relationship_to_declarant}</td>
                      <td style={tdStyle}>{member.relationship_to_household_head}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Signature Section */}
          <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
            <div style={{ width: '45%', textAlign: 'center' }}>
              <div style={{ fontStyle: 'italic', marginBottom: '4px' }}>Xác nhận của cơ quan đăng ký cư trú</div>
              <div style={{ fontSize: '11px', marginBottom: '60px' }}>(Ký, đóng dấu)</div>
              <div>.....................................</div>
            </div>
            <div style={{ width: '45%', textAlign: 'center' }}>
              <div style={{ fontStyle: 'italic' }}>
                ......, ngày ...... tháng ...... năm ......
              </div>
              <div style={{ fontStyle: 'italic', marginBottom: '4px' }}>Người khai</div>
              <div style={{ fontSize: '11px', marginBottom: '60px' }}>(Ký, ghi rõ họ tên)</div>
              <div style={{ fontWeight: 'bold' }}>{data.full_name}</div>
            </div>
          </div>
        </div>
      </>
    );
  }
);

CT01PrintLayout.displayName = 'CT01PrintLayout';

export default CT01PrintLayout;

// Shared cell styles
const tdLabelStyle: React.CSSProperties = {
  border: '1px solid #000',
  padding: '4px 6px',
  fontWeight: 'bold',
  width: '22%',
  backgroundColor: '#f9f9f9',
  whiteSpace: 'nowrap',
};

const tdValueStyle: React.CSSProperties = {
  border: '1px solid #000',
  padding: '4px 6px',
  width: '28%',
};

const thStyle: React.CSSProperties = {
  border: '1px solid #000',
  padding: '4px 6px',
  fontWeight: 'bold',
  textAlign: 'center',
  backgroundColor: '#f0f0f0',
};

const tdStyle: React.CSSProperties = {
  border: '1px solid #000',
  padding: '4px 6px',
};
