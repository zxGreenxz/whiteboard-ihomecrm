import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { QK } from '@/hooks/useZaloChat';
import { forwardZaloMedia, type ForwardMediaInput, type ForwardMediaRpc } from '@/lib/zaloForwardMedia';

// Typed domain facade: generated types describe the deployed schema, while this
// additive RPC ships with the forwarding migration. Validate the full receipt.
const callForwardRpc: ForwardMediaRpc = (name, args) =>
  (supabase.rpc as unknown as ForwardMediaRpc)(name, args);

export function useForwardZaloMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ForwardMediaInput) => forwardZaloMedia(callForwardRpc, input),
    retry: false,
    onSuccess: result => {
      for (const recipient of result.recipients) {
        if (recipient.status === 'queued') void qc.invalidateQueries({ queryKey: QK.messages(recipient.conversation_id) });
      }
      void qc.invalidateQueries({ queryKey: QK.conversations });
    },
  });
}
