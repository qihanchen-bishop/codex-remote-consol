import { questionId } from '../public/questions.mjs';
export { questionId, parseQuestionReplies, pendingQuestionItems } from '../public/questions.mjs';

export function buildQuestionReply(item, answers, answered = new Set()) {
  if (item?.type !== 'agentMessage' || !Array.isArray(item.questions) || !item.questions.length) throw Object.assign(new Error('这条消息没有可回答的问题'), {status: 400});
  if (!Array.isArray(answers) || !answers.length || answers.length > item.questions.length) throw Object.assign(new Error('请选择或填写回答'), {status: 400});
  const seen = new Set();
  const replies = answers.map(value => {
    if (!value || typeof value !== 'object') throw Object.assign(new Error('回答内容无效'), {status: 400});
    const {questionIndex, answer} = value;
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= item.questions.length || seen.has(questionIndex) || typeof answer !== 'string' || !answer.trim() || answer.length > 10000) throw Object.assign(new Error('问题编号或回答内容无效'), {status: 400});
    seen.add(questionIndex);
    const id = questionId(item.id, questionIndex);
    if (answered.has(id) || answered.has(item.id)) throw Object.assign(new Error('此问题已经回答，请刷新查看最新会话'), {status: 409});
    return {questionItemId: id, question: item.questions[questionIndex].title, answer: answer.trim()};
  });
  return {replies, text: `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`};
}
