export function questionId(itemId, index) {
  return JSON.stringify(['request_user_input_async', itemId, index]);
}

export function parseQuestionReplies(item) {
  if (item?.type !== 'userMessage') return [];
  const text = (item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  const match = text.match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return [];
  try {
    const data = JSON.parse(match[1]);
    return (Array.isArray(data) ? data : [data]).filter(r => typeof r?.questionItemId === 'string' && typeof r.answer === 'string');
  } catch { return []; }
}

// Turns and their items must be in chronological order. Optional questions can
// remain open while tools run, but a new instruction or final result ends them.
export function pendingQuestionItems(turns) {
  const pending = new Set();
  for (const turn of turns) {
    const lastAgent = turn.status === 'completed'
      ? (turn.items || []).findLast(i => i.type === 'agentMessage') : null;
    for (const item of turn.items || []) {
      if (item.type === 'userMessage' && !parseQuestionReplies(item).length) pending.clear();
      if (item.type !== 'agentMessage') continue;
      if (item.questions?.length) pending.add(item.id);
      else if (item.phase === 'final_answer' || item === lastAgent) pending.clear();
    }
    if (['interrupted', 'failed'].includes(turn.status) || turn.error) pending.clear();
  }
  return pending;
}
