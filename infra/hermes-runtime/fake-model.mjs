// Synthetic OpenAI-compatible model. No upstream AI/network request is made.
// It deliberately emits an unavailable tool in one scenario to exercise the
// Hermes dispatcher, rather than merely inspecting the advertised schema.
export function modelReply(body, { actor, sentinels, connectionTokens = [] }) {
  if (!['a', 'b'].includes(actor) || !Array.isArray(body.messages)) throw new Error('Invalid synthetic model request');
  const serialized = JSON.stringify(body);
  const other = actor === 'a' ? 'b' : 'a';
  if (serialized.includes(sentinels[other])) throw new Error('Foreign memory reached the model');
  if (connectionTokens.some((token) => serialized.includes(token))) throw new Error('Broker credential reached the model');
  const toolNames = (body.tools ?? []).map((t) => t.function?.name).sort();
  if (toolNames.some((name) => name !== 'mcp__crm__crm_auth_context')) throw new Error('Unexpected model tool surface');
  const last = body.messages.at(-1);
  let message;
  let finishReason;
  if (last?.role === 'tool') {
    message = { role: 'assistant', content: String(last.content) };
    finishReason = 'stop';
  } else {
    const prompt = [...body.messages].reverse().find((m) => m.role === 'user')?.content;
    if (typeof prompt !== 'string' || !prompt.startsWith('FIXTURE_')) throw new Error('Only fixture prompts are accepted');
    const forbidden = prompt.startsWith('FIXTURE_FORBIDDEN_TOOL');
    const spoof = prompt.startsWith('FIXTURE_SPOOF_IDENTITY');
    message = {
      role: 'assistant', content: null,
      tool_calls: [{ id: `fixture-call-${actor}`, type: 'function', function: {
        name: forbidden ? 'terminal' : 'mcp__crm__crm_auth_context',
        arguments: JSON.stringify(forbidden ? { command: 'printf FIXTURE_FORBIDDEN_EXECUTION > /opt/data/forbidden-executed' }
          : spoof ? { userId: 'synthetic-other-user', organizationId: 'synthetic-other-org' } : {}),
      } }],
    };
    finishReason = 'tool_calls';
  }
  return {
    response: { id: `fixture-${actor}`, object: 'chat.completion', created: 1,
      model: 'fixture-model', choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    audit: { actor, toolNames, ownMemorySeen: serialized.includes(sentinels[actor]),
      foreignMemorySeen: false, emittedTool: message.tool_calls?.[0]?.function.name ?? null },
  };
}

export function sseReply(response) {
  const choice = response.choices[0];
  const delta = { ...choice.message };
  if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call, index) => ({ index, ...call }));
  const chunk = { ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] };
  const end = { ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] };
  return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`;
}
