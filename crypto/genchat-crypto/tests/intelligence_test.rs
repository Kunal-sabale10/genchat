use genchat_crypto::intelligence::{ActionType, LocalIntelligence};

#[test]
fn test_local_intelligence_action_items_extraction() {
    let message = "Please make sure to review the PR before EOD. Let's meet at 3pm for a quick sync. Check https://github.com/genchat for docs.";
    let actions = LocalIntelligence::extract_action_items(message);

    assert!(
        actions.iter().any(|a| a.action_type == ActionType::Todo),
        "Expected TODO action item detected"
    );
    assert!(
        actions.iter().any(|a| a.action_type == ActionType::Meeting),
        "Expected Meeting action item detected"
    );
    assert!(
        actions.iter().any(|a| a.action_type == ActionType::Deadline),
        "Expected Deadline action item detected"
    );
    assert!(
        actions.iter().any(|a| a.action_type == ActionType::Link),
        "Expected Link action item detected"
    );
}

#[test]
fn test_local_conversation_summary_and_smart_replies() {
    let history = [
        "Hey, are you free to talk about the MLS group rekeying?",
        "Yes, let's meet at 4pm to finalize the TreeKEM implementation.",
        "TODO: Need to deploy the updated MinIO media storage service.",
        "Thanks for the update!",
    ];

    let summary = LocalIntelligence::summarize_conversation(&history);
    assert!(!summary.key_topics.is_empty());
    assert!(!summary.action_items.is_empty());

    let replies = LocalIntelligence::suggest_smart_replies("Can you check the latest build status?");
    assert!(!replies.is_empty());
    assert!(replies.iter().any(|r| r.contains("take care of it") || r.contains("On it")));
}
