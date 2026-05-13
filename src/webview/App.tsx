/**
 * Top-level Preact component for the Majestix AI webview.
 * Manages state via useReducer, handles incoming messages from the extension host.
 */

import { useReducer, useEffect, useState, useRef } from "preact/hooks";
import { reducer, initialState } from "./state";
import type { ExtensionInMessage } from "./types";
import { postMessage } from "./utils";

import { Header } from "./components/Header";
import { AgentStatusBar } from "./components/AgentStatusBar";
import { ConversationView } from "./components/ConversationView";
import { InputArea } from "./components/InputArea";
import { SessionDrawer } from "./components/SessionDrawer";

interface Props {
  logoUri: string;
}

export function App({ logoUri }: Props) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [dropVisible, setDropVisible] = useState(false);
  const dragCounterRef = useRef(0);

  // ── Handle messages from the extension host ──
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as ExtensionInMessage;
      switch (msg.type) {
        case "thinking":
          dispatch({ type: "THINKING_START" });
          break;
        case "thinking_content":
          dispatch({ type: "THINKING_CONTENT", content: msg.content });
          break;
        case "thinking_done":
          dispatch({ type: "THINKING_DONE" });
          break;
        case "text": {
          const textContent = (msg as { content?: string }).content;
          if (textContent && textContent.trim() !== "") {
            dispatch({ type: "STREAM_TEXT", content: textContent });
          }
          break;
        }
        case "tool_call":
          dispatch({ type: "TOOL_CALL", id: msg.id, name: msg.name, input: msg.input });
          break;
        case "tool_result":
          dispatch({ type: "TOOL_RESULT", id: msg.id, content: msg.content, isError: msg.is_error });
          break;
        case "file_edited":
          dispatch({ type: "FILE_EDITED", path: msg.path, op: msg.op });
          break;
        case "command_output":
          dispatch({ type: "COMMAND_OUTPUT", content: msg.content });
          break;
        case "approval_request":
          // Check auto-approve
          if (state.sessionAutoApprove || Date.now() < state.autoApproveUntil) {
            postMessage({ type: "approvalResponse", approved: true });
          } else {
            dispatch({ type: "APPROVAL_REQUEST", toolName: msg.toolName, description: msg.description, detail: msg.detail });
          }
          break;
        case "completion":
          dispatch({ type: "COMPLETION", result: msg.result, command: msg.command });
          break;
        case "credits":
          dispatch({ type: "CREDITS", model: msg.model, credits: msg.credits_used });
          break;
        case "done":
          dispatch({ type: "STREAM_DONE" });
          break;
        case "stopped":
          dispatch({ type: "STREAM_STOPPED" });
          break;
        case "error":
          dispatch({ type: "STREAM_ERROR", message: msg.message });
          break;
        case "models":
          dispatch({ type: "SET_MODELS", models: msg.models });
          break;
        case "ask":
          dispatch({ type: "ASK", message: msg.message, rawQuestion: msg.rawQuestion });
          postMessage({ type: "sendAgent", message: msg.message, model: state.selectedModel || undefined, mode: state.mode });
          break;
        case "filesAttached":
          dispatch({ type: "FILES_ATTACHED", files: msg.files });
          break;
        case "clearPastedPath":
          dispatch({ type: "CLEAR_PASTED_PATH", path: msg.path });
          break;
        case "session:list":
          dispatch({ type: "SET_SESSIONS", sessions: msg.sessions });
          break;
        case "session:loaded":
          dispatch({ type: "SESSION_LOADED", session: msg.session });
          break;
        case "session:active":
          dispatch({ type: "SET_ACTIVE_SESSION", id: msg.id });
          break;
        case "session:deleted":
          dispatch({ type: "SESSION_DELETED", id: msg.id });
          break;
        case "session:error":
          dispatch({ type: "STREAM_ERROR", message: msg.message });
          break;
        case "focusInput":
          dispatch({ type: "FOCUS_INPUT" });
          break;
        case "keyStatus":
          dispatch({ type: "SET_KEY_STATUS", hasKey: msg.hasKey, maskedKey: msg.maskedKey ?? "" });
          break;
        case "fileSearchResults":
          dispatch({ type: "SET_MENTION_RESULTS", files: msg.files });
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => { window.removeEventListener("message", handler); };
  }, [state.sessionAutoApprove, state.autoApproveUntil, state.selectedModel, state.mode, state.isStreaming]);

  // ── Request initial data ──
  useEffect(() => {
    postMessage({ type: "loadModels" });
    postMessage({ type: "keyStatus" });
  }, []);

  // ── Global Escape key to stop streaming ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && state.isStreaming) {
        e.preventDefault();
        postMessage({ type: "stop" });
      }
    };
    document.addEventListener("keydown", handler);
    return () => { document.removeEventListener("keydown", handler); };
  }, [state.isStreaming]);

  // ── Drag and drop ──
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current++;
      if (dragCounterRef.current === 1) setDropVisible(true);
    };
    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDropVisible(false); }
    };
    const handleDragOver = (e: DragEvent) => { e.preventDefault(); };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDropVisible(false);
      if (e.dataTransfer !== null && e.dataTransfer.files.length > 0) {
        const names: string[] = [];
        for (const file of e.dataTransfer.files) {
          if (file.name) names.push(file.name);
        }
        if (names.length > 0) postMessage({ type: "dropFiles", names });
      }
      const uriList = e.dataTransfer?.getData("text/uri-list") ?? "";
      if (uriList) {
        const uris = uriList.split("\n").filter(u => u && !u.startsWith("#"));
        if (uris.length > 0) postMessage({ type: "dropUris", uris });
      }
    };
    document.addEventListener("dragenter", handleDragEnter);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);
    return () => {
      document.removeEventListener("dragenter", handleDragEnter);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, []);

  return (
    <>
      <div class={`drop-overlay ${dropVisible ? "visible" : ""}`}>Drop files to attach</div>

      <SessionDrawer
        open={state.drawerOpen}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        searchQuery={state.sessionSearch}
        dispatch={dispatch}
      />

      <Header
        mode={state.mode}
        selectedModel={state.selectedModel}
        models={state.models}
        thinkingEnabled={state.thinkingEnabled}
        hasMessages={state.hasMessages}
        items={state.items}
        keyStatus={state.keyStatus}
        autoApproveUntil={state.autoApproveUntil}
        dispatch={dispatch}
      />

      <AgentStatusBar
        active={state.agentStatus.active}
        step={state.agentStatus.step}
        cost={state.agentStatus.cost}
        startTime={state.agentStatus.startTime}
      />

      <ConversationView
        items={state.items}
        hasMessages={state.hasMessages}
        isStreaming={state.isStreaming}
        lastSentMessage={state.lastSentMessage}
        logoUri={logoUri}
        dispatch={dispatch}
      />

      <InputArea
        isStreaming={state.isStreaming}
        attachedFiles={state.attachedFiles}
        mode={state.mode}
        selectedModel={state.selectedModel}
        inputHistory={state.inputHistory}
        historyIndex={state.historyIndex}
        mentionResults={state.mentionResults}
        dispatch={dispatch}
      />
    </>
  );
}
