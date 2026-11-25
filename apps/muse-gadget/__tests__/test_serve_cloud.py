import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

path = Path(__file__).resolve().parents[1] / "@assets" / "serve-cloud.py"
spec = importlib.util.spec_from_file_location("muse_gadget_serve_cloud", path)
serve_cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve_cloud)

CHAT = "chat-this"
OTHER = "chat-other"


class ServeCloudTests(unittest.TestCase):
    def test_approvals_snapshot_counts_only_pending_approvals_for_this_chat(self):
        events = [
            {"event": "agent.status", "payload": {"session_id": CHAT, "activity_code": "working"}},
            {"event": "task.status", "payload": {"session_id": CHAT, "status": "running", "active_subagent_count": 1}},
            {"event": "task.status", "payload": {"thread_id": OTHER, "status": "pending_user_confirmation"}},
            {"event": "task.status", "payload": {"is_thread": False, "status": "pending_user_confirmation"}},
            {"event": "approvals.snapshot", "payload": {"pending_approvals": [
                {"approval_id": "other-trace", "status": "pending",
                 "runtime_request_trace": {"thread_id": OTHER}},
                {"approval_id": "other-scope", "status": "pending",
                 "scope": {"thread_id": OTHER}},
                {"approval_id": "main-chat", "status": "pending",
                 "scope": {"requester_source": "runtime"}},
                {"approval_id": "schedule", "status": "pending",
                 "scope": {"scope_type": "schedule", "schedule_id": "morning"}},
                {"approval_id": "already-allowed", "status": "allowed",
                 "runtime_request_trace": {"thread_id": CHAT}},
            ]}},
        ]
        live = serve_cloud._scoped_live_from_events(events, CHAT)
        self.assertEqual(live["pending_approval_count"], 0)
        self.assertTrue(live["pending_approvals_scoped"])
        self.assertEqual(live["agent_activity_code"], "working")
        self.assertEqual(live["task_status"], "running")

    def test_approvals_snapshot_counts_matching_side_chat_approvals_across_formats(self):
        events = [
            {"event": "approvals.snapshot", "payload": {"pending": [
                {"approval_id": "a1", "status": "pending",
                 "runtime_request_trace": {"thread_id": CHAT}},
                {"approval_id": "a2", "status": "pending",
                 "scope": {"thread_id": f" {CHAT} "}},
                {"approval_id": "a3", "status": "pending",
                 "scope": {"runtime_request_trace": {"thread_id": CHAT}}},
                {"approval_id": "a4", "status": "pending", "thread_id": CHAT},
                {"approval_id": "other", "status": "pending", "thread_id": OTHER},
            ]}},
        ]
        live = serve_cloud._scoped_live_from_events(events, CHAT)
        self.assertEqual(live["pending_approval_count"], 4)
        self.assertTrue(live["pending_approvals_scoped"])
        self.assertTrue(live["snapshot_received"])

    def test_configure_muse_mcp_patches_stamp_and_live_snapshot(self):
        fake = SimpleNamespace(_stamped=lambda caller, text: f"stamp:{text}", _live_from_events=None)
        serve_cloud.configure_muse_mcp(fake)
        self.assertEqual(fake._stamped("hermes22muse", "hi"), "hi")
        self.assertIs(fake._live_from_events, serve_cloud._scoped_live_from_events)
