import { usePhoneViewport } from "@/hooks/use-mobile";
import OpenClawZaloDesktopPage from "./OpenClawZaloDesktopPage";
import OpenClawZaloMobilePage from "./OpenClawZaloMobilePage";

export default function OpenClawZaloPage() {
  const isPhone = usePhoneViewport();
  return isPhone ? <OpenClawZaloMobilePage /> : <OpenClawZaloDesktopPage />;
}
