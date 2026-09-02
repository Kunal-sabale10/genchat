use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ActionType {
    Todo,
    Meeting,
    Deadline,
    Link,
    Question,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionItem {
    pub action_type: ActionType,
    pub text: String,
    pub context: String,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub key_topics: Vec<String>,
    pub summary_bullets: Vec<String>,
    pub action_items: Vec<ActionItem>,
}

/// Local On-Device Intelligence Engine (Guaranteed zero data leakage)
pub struct LocalIntelligence;

impl LocalIntelligence {
    /// Extract action items, tasks, meetings, and deadlines from decrypted text locally
    pub fn extract_action_items(text: &str) -> Vec<ActionItem> {
        let mut items = Vec::new();
        let lines: Vec<&str> = text.lines().flat_map(|l| l.split(&['.', '!', '?'][..])).collect();

        for raw_line in lines {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let lower = line.to_lowercase();

            // 1. Deadline detection
            let is_deadline = lower.contains("deadline")
                || lower.contains("due ")
                || lower.contains("due:")
                || lower.contains("due by")
                || lower.contains("before eod")
                || lower.contains("by tomorrow")
                || lower.contains("by friday")
                || lower.contains("by monday")
                || lower.contains("by end of day")
                || lower.contains("by eod")
                || (lower.contains("by ") && (lower.contains("pm") || lower.contains("am")));

            if is_deadline {
                items.push(ActionItem {
                    action_type: ActionType::Deadline,
                    text: line.to_string(),
                    context: line.to_string(),
                    confidence: 0.92,
                });
            }

            // 2. TODO / Task detection
            let is_todo = lower.starts_with("todo:")
                || lower.starts_with("task:")
                || lower.starts_with("- [ ]")
                || lower.contains("please make sure to")
                || lower.contains("need to")
                || lower.contains("action item:")
                || lower.contains("will implement");

            if is_todo && !is_deadline {
                items.push(ActionItem {
                    action_type: ActionType::Todo,
                    text: line.to_string(),
                    context: line.to_string(),
                    confidence: 0.95,
                });
            }

            // 3. Meeting / Call detection
            let is_meeting = lower.contains("let's meet")
                || lower.contains("meeting at")
                || lower.contains("sync at")
                || lower.contains("call at")
                || lower.contains("schedule a call")
                || lower.contains("jump on a call");

            if is_meeting {
                items.push(ActionItem {
                    action_type: ActionType::Meeting,
                    text: line.to_string(),
                    context: line.to_string(),
                    confidence: 0.90,
                });
            }

            // 4. URL / Link detection
            if lower.contains("http://") || lower.contains("https://") {
                items.push(ActionItem {
                    action_type: ActionType::Link,
                    text: line.to_string(),
                    context: line.to_string(),
                    confidence: 0.99,
                });
            }
        }

        items
    }

    /// Extractive conversation summarizer across local message history
    pub fn summarize_conversation(messages: &[&str]) -> ConversationSummary {
        let mut key_topics = Vec::new();
        let mut summary_bullets = Vec::new();
        let mut all_actions = Vec::new();

        for msg in messages {
            let actions = Self::extract_action_items(msg);
            all_actions.extend(actions);

            // Filter meaningful non-trivial messages for bullets
            let trimmed = msg.trim();
            if trimmed.len() > 15 && !trimmed.starts_with("ok") && !trimmed.starts_with("thanks") {
                if summary_bullets.len() < 5 {
                    summary_bullets.push(trimmed.to_string());
                }
            }
        }

        if !all_actions.is_empty() {
            key_topics.push("Action Items & Tasks".into());
        }
        if messages.len() > 2 {
            key_topics.push("General Discussion".into());
        }

        ConversationSummary {
            key_topics,
            summary_bullets,
            action_items: all_actions,
        }
    }

    /// Generate contextual smart replies locally
    pub fn suggest_smart_replies(last_message: &str) -> Vec<String> {
        let lower = last_message.to_lowercase().trim().to_string();

        if lower.contains("how are you") || lower.contains("how's it going") {
            vec![
                "I'm doing well, thanks! How about you?".into(),
                "All good on my end! What's up?".into(),
                "Great! Ready to dive in.".into(),
            ]
        } else if lower.contains("thank") {
            vec![
                "You're welcome!".into(),
                "No problem at all!".into(),
                "Glad to help!".into(),
            ]
        } else if lower.contains("can you") || lower.contains("could you") || lower.contains("please") {
            vec![
                "On it right now!".into(),
                "Sure thing, I'll take care of it.".into(),
                "Will do shortly.".into(),
            ]
        } else if lower.contains("are you available") || lower.contains("free to talk") || lower.contains("jump on a call") {
            vec![
                "Yes, free now!".into(),
                "Give me 5 minutes.".into(),
                "Can we connect in an hour?".into(),
            ]
        } else if lower.contains("?") {
            vec![
                "Let me check and get back to you.".into(),
                "Yes, absolutely.".into(),
                "Sounds good to me!".into(),
            ]
        } else {
            vec![
                "Sounds good!".into(),
                "Got it, thanks for the update.".into(),
                "Let me know if you need anything else.".into(),
            ]
        }
    }
}
