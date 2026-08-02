import MainLayout from "@/components/layout/MainLayout";
import OpenClawCockpit from "@/components/openclaw-zalo/OpenClawCockpit";

export default function OpenClawZaloDesktopPage() {
  return (
    <MainLayout fullBleed>
      <OpenClawCockpit mobile={false} />
    </MainLayout>
  );
}
