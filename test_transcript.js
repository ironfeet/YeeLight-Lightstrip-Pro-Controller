const fs = require('fs');

const lines = [
  {"step_index":893,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-06-07T16:00:13Z","tool_calls":[{"name":"default_api:run_command","args":{"CommandLine":"something"}}]}
];

function isToolType(type) {
  const allTools = [
    'WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT',
    'RUN_COMMAND', 'MANAGE_TASK', 'MANAGE_SUBAGENTS',
    'VIEW_FILE', 'GREP_SEARCH', 'SEARCH_WEB', 'READ_URL_CONTENT', 'LIST_DIR', 'READ_URL', 'ASK_PERMISSION', 'LIST_PERMISSIONS',
    'INVOKE_SUBAGENT', 'SEND_MESSAGE', 'DEFINE_SUBAGENT',
    'GENERATE_IMAGE', 'ASK_QUESTION', 'CODE_ACTION'
  ];
  return allTools.includes(type);
}

function getActiveState(type, toolCalls) {
  const CODING   = ['WRITE_TO_FILE', 'REPLACE_FILE_CONTENT', 'MULTI_REPLACE_FILE_CONTENT', 'CODE_ACTION'];
  const COMMAND  = ['RUN_COMMAND', 'MANAGE_TASK', 'MANAGE_SUBAGENTS'];
  const RESEARCH = ['VIEW_FILE', 'GREP_SEARCH', 'SEARCH_WEB', 'READ_URL_CONTENT', 'LIST_DIR', 'READ_URL', 'ASK_PERMISSION', 'LIST_PERMISSIONS'];
  const DELEGATE = ['INVOKE_SUBAGENT', 'SEND_MESSAGE', 'DEFINE_SUBAGENT'];
  const IMAGE    = ['GENERATE_IMAGE'];
  const CONFIRM  = ['ASK_QUESTION'];

  let actionName = type.toUpperCase();
  if (toolCalls && toolCalls.length > 0) {
    actionName = (toolCalls[0]?.name || toolCalls[0]?.function?.name || '').toUpperCase();
    actionName = actionName.replace(/^DEFAULT_API:/, '');
  }

  if (CODING.includes(actionName))   return { state: 'coding',      label: 'Coding',      description: 'Editing files' };
  if (COMMAND.includes(actionName))  return { state: 'running',     label: 'Running',     description: 'Executing terminal command' };
  if (RESEARCH.includes(actionName)) return { state: 'researching', label: 'Researching', description: 'Gathering context' };
  if (DELEGATE.includes(actionName)) return { state: 'delegating',  label: 'Delegating',  description: 'Managing subagents' };
  if (IMAGE.includes(actionName))    return { state: 'thinking',    label: 'Generating',  description: 'Creating image' };
  if (CONFIRM.includes(actionName))  return { state: 'waiting',     label: 'Asking You',  description: 'Awaiting your answer' };

  if (toolCalls && toolCalls.length > 0) {
    return { state: 'thinking', label: 'Thinking', description: `Using tool: ${actionName.toLowerCase()}` };
  }
  return { state: 'thinking', label: 'Thinking', description: 'Generating response' };
}

function classifyStatus() {
  const last = lines[lines.length - 1];
  const rawType  = last?.type   || '';
  const type     = rawType.toUpperCase();
  const source   = last?.source || '';
  const status   = last?.status || '';
  const toolCalls = last?.tool_calls || [];

  if (status === 'WAITING' || status === 'PENDING') {
    return { state: 'waiting', label: 'Waiting for You', description: 'A command is pending your approval' };
  }

  if (status === 'RUNNING' || status === 'IN_PROGRESS') {
    if (['RUN_COMMAND', 'ASK_QUESTION', 'ASK_PERMISSION'].includes(type)) {
      return { state: 'waiting', label: 'Waiting for You', description: `Action pending your input` };
    }
    return getActiveState(type, toolCalls);
  }

  if (status === 'DONE') {
    if (type === 'USER_INPUT') return { state: 'thinking', label: 'Thinking', description: 'Processing your request' };
    if (source === 'SYSTEM' || type.includes('MESSAGE')) return { state: 'thinking', label: 'Thinking', description: 'Reading system update' };

    if (toolCalls.length > 0) {
      let actionName = (toolCalls[0]?.name || toolCalls[0]?.function?.name || '').toUpperCase();
      actionName = actionName.replace(/^DEFAULT_API:/, '');
      
      if (['RUN_COMMAND', 'ASK_QUESTION', 'ASK_PERMISSION'].includes(actionName)) {
        return { state: 'waiting', label: 'Waiting for You', description: 'Action pending your approval' };
      }
      return getActiveState(type, toolCalls);
    }

    if (isToolType(type) || type === 'CODE_ACTION') return getActiveState(type, []);
    if (type === 'PLANNER_RESPONSE' || type === 'GENERIC') return { state: 'idle', label: 'Idle', description: 'Waiting for instructions' };
  }
  return { state: 'idle', label: 'Idle', description: 'Waiting for instructions' };
}

console.log(classifyStatus());
