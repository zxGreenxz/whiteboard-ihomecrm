import OpenClawCockpit from "@/components/openclaw-zalo/OpenClawCockpit";

export default function OpenClawZaloMobilePage() {
  return (
    <div className="min-h-[100dvh] w-full max-w-full overflow-x-hidden bg-[#f7f2e8]">
      <div className="h-[100dvh] min-h-0">
        <OpenClawCockpit mobile />
      </div>
    </div>
  );
}
