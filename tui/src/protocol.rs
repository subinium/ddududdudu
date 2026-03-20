use serde::{Deserialize, Serialize};

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeSlashCommand {
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) value: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeToolCallState {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) args: String,
    pub(crate) summary: String,
    pub(crate) result: Option<String>,
    pub(crate) status: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMessageState {
    pub(crate) id: String,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) timestamp: u64,
    #[serde(default)]
    pub(crate) is_streaming: bool,
    #[serde(default)]
    pub(crate) thinking: Option<String>,
    #[serde(default)]
    pub(crate) is_thinking: Option<bool>,
    #[serde(default)]
    pub(crate) tool_calls: Vec<NativeToolCallState>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct NativeModeState {
    pub(crate) name: String,
    pub(crate) label: String,
    pub(crate) tagline: String,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) active: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct NativeProviderState {
    pub(crate) name: String,
    pub(crate) available: bool,
    pub(crate) source: Option<String>,
    pub(crate) token_type: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMcpState {
    pub(crate) configured_servers: u64,
    pub(crate) connected_servers: u64,
    pub(crate) tool_count: u64,
    pub(crate) server_names: Vec<String>,
    pub(crate) connected_names: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeLspState {
    pub(crate) available_servers: u64,
    pub(crate) connected_servers: u64,
    pub(crate) server_labels: Vec<String>,
    pub(crate) connected_labels: Vec<String>,
}

pub(crate) fn default_true() -> bool {
    true
}

pub(crate) fn default_ask_user_kind() -> String {
    "input".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAskUserOptionState {
    pub(crate) value: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) description: Option<String>,
    #[serde(default)]
    pub(crate) recommended: bool,
    #[serde(default)]
    pub(crate) danger: bool,
    #[serde(default)]
    pub(crate) shortcut: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAskUserValidationState {
    #[serde(default)]
    pub(crate) pattern: Option<String>,
    #[serde(default)]
    pub(crate) min_length: Option<u64>,
    #[serde(default)]
    pub(crate) max_length: Option<u64>,
    #[serde(default)]
    pub(crate) message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAskUserState {
    pub(crate) question: String,
    #[serde(default = "default_ask_user_kind")]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) detail: Option<String>,
    #[serde(default)]
    pub(crate) placeholder: Option<String>,
    #[serde(default)]
    pub(crate) submit_label: Option<String>,
    #[serde(default = "default_true")]
    pub(crate) allow_custom_answer: bool,
    #[serde(default = "default_true")]
    pub(crate) required: bool,
    #[serde(default)]
    pub(crate) default_value: Option<String>,
    #[serde(default)]
    pub(crate) default_option_index: Option<usize>,
    #[serde(default)]
    pub(crate) validation: Option<NativeAskUserValidationState>,
    #[serde(default)]
    pub(crate) options: Vec<NativeAskUserOptionState>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskUserAnswerPayload {
    pub(crate) value: String,
    pub(crate) source: String,
    pub(crate) option_index: Option<usize>,
    pub(crate) option_label: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePlanItemState {
    pub(crate) id: String,
    pub(crate) step: String,
    pub(crate) status: String,
    pub(crate) owner: Option<String>,
    pub(crate) updated_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeAgentActivityState {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) mode: Option<String>,
    pub(crate) purpose: Option<String>,
    pub(crate) checklist_id: Option<String>,
    pub(crate) status: String,
    pub(crate) detail: Option<String>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) updated_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeBackgroundJobState {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) label: String,
    pub(crate) status: String,
    pub(crate) detail: Option<String>,
    pub(crate) started_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) finished_at: Option<u64>,
    pub(crate) purpose: Option<String>,
    pub(crate) preferred_mode: Option<String>,
    pub(crate) strategy: Option<String>,
    pub(crate) attempt: Option<u64>,
    pub(crate) has_result: Option<bool>,
    pub(crate) result_preview: Option<String>,
    pub(crate) workspace_path: Option<String>,
    pub(crate) prompt_preview: Option<String>,
    pub(crate) checklist: Vec<NativeJobChecklistItem>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeJobChecklistItem {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) owner: Option<String>,
    pub(crate) status: String,
    pub(crate) detail: Option<String>,
    pub(crate) depends_on: Option<Vec<String>>,
    pub(crate) handoff_to: Option<String>,
    pub(crate) updated_at: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeArtifactState {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) title: String,
    pub(crate) summary: String,
    pub(crate) source: String,
    pub(crate) mode: Option<String>,
    pub(crate) created_at: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeGitState {
    pub(crate) branch: Option<String>,
    pub(crate) changed_file_count: u64,
    pub(crate) staged_file_count: u64,
    pub(crate) has_uncommitted: bool,
    pub(crate) changed_files: Vec<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeWorkspaceState {
    pub(crate) label: String,
    pub(crate) path: String,
    pub(crate) kind: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeVerificationState {
    pub(crate) status: String,
    pub(crate) summary: Option<String>,
    pub(crate) cwd: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeRequestEstimateState {
    pub(crate) system: u64,
    pub(crate) history: u64,
    pub(crate) tools: u64,
    pub(crate) prompt: u64,
    pub(crate) total: u64,
    pub(crate) mode: String,
    pub(crate) note: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeTuiState {
    pub(crate) ready: bool,
    pub(crate) version: String,
    pub(crate) cwd: String,
    pub(crate) mode: String,
    pub(crate) modes: Vec<NativeModeState>,
    pub(crate) provider: String,
    pub(crate) model: String,
    pub(crate) models: Vec<String>,
    pub(crate) auth_type: Option<String>,
    pub(crate) auth_source: Option<String>,
    pub(crate) permission_profile: String,
    pub(crate) loading: bool,
    pub(crate) loading_label: String,
    pub(crate) loading_since: Option<u64>,
    pub(crate) playing_with_fire: bool,
    pub(crate) context_percent: f64,
    pub(crate) context_tokens: u64,
    pub(crate) context_limit: u64,
    pub(crate) context_preview: Option<String>,
    pub(crate) request_estimate: Option<NativeRequestEstimateState>,
    pub(crate) queued_prompts: Vec<String>,
    pub(crate) providers: Vec<NativeProviderState>,
    pub(crate) mcp: Option<NativeMcpState>,
    pub(crate) lsp: Option<NativeLspState>,
    pub(crate) messages: Vec<NativeMessageState>,
    pub(crate) ask_user: Option<NativeAskUserState>,
    pub(crate) slash_commands: Vec<NativeSlashCommand>,
    pub(crate) session_id: Option<String>,
    pub(crate) remote_session_id: Option<String>,
    pub(crate) remote_session_count: u64,
    pub(crate) team_run_strategy: Option<String>,
    pub(crate) team_run_task: Option<String>,
    pub(crate) team_run_since: Option<u64>,
    pub(crate) todos: Vec<NativePlanItemState>,
    pub(crate) agent_activities: Vec<NativeAgentActivityState>,
    pub(crate) background_jobs: Vec<NativeBackgroundJobState>,
    pub(crate) artifacts: Vec<NativeArtifactState>,
    pub(crate) git: Option<NativeGitState>,
    pub(crate) workspace: Option<NativeWorkspaceState>,
    pub(crate) verification: Option<NativeVerificationState>,
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum BridgeEvent {
    #[serde(rename = "content_delta")]
    ContentDelta {
        id: String,
        delta: String,
    },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta {
        id: String,
        delta: String,
        #[serde(rename = "isThinking")]
        is_thinking: bool,
    },
    #[serde(rename = "stream_end")]
    StreamEnd {
        id: String,
    },
    State {
        state: NativeTuiState,
    },
    Fatal {
        message: String,
    },
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum BridgeCommand {
    Submit { content: String },
    PrefetchContext { content: String },
    Abort,
    ClearMessages,
    RunSlash { command: String },
    SetMode { mode: String },
    CycleMode { direction: i8 },
    SetModel { model: String },
    AnswerAskUser { answer: AskUserAnswerPayload },
}
