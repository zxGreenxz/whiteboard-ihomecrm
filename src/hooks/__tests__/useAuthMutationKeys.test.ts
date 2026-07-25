import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  useMutation: vi.fn((options: unknown) => options),
  navigate: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn((options: unknown) => options),
  useMutation: harness.useMutation,
  useQueryClient: () => ({
    invalidateQueries: harness.invalidateQueries,
    clear: harness.clear,
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => harness.navigate,
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: {} },
}));

import {
  useForgotPassword,
  useLogin,
  useLogout,
  useRegister,
  useResetPassword,
} from "@/hooks/useAuth";

describe("auth mutation keys", () => {
  it.each([
    ["register", useRegister],
    ["login", useLogin],
    ["logout", useLogout],
    ["forgot-password", useForgotPassword],
    ["reset-password", useResetPassword],
  ])("marks %s as auth-scoped", (operation, useMutationHook) => {
    const options = useMutationHook() as unknown as {
      mutationKey: readonly unknown[];
    };

    expect(options.mutationKey).toEqual(["auth", operation]);
  });
});
