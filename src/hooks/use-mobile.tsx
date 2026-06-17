import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

/**
 * Như useIsMobile nhưng KHỞI TẠO ĐỒNG BỘ từ matchMedia (≤767px) nên không nháy
 * bảng desktop trước khi effect chạy. Dùng để rẽ nhánh trang app full-screen
 * trên điện thoại (giống ContractsPage) — wrapper giữ số hook cố định, an toàn
 * rules-of-hooks khi đổi kích thước.
 */
export function usePhoneViewport() {
  const [phone, setPhone] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches,
  );
  React.useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const onChange = () => setPhone(mql.matches);
    mql.addEventListener("change", onChange);
    onChange();
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return phone;
}
