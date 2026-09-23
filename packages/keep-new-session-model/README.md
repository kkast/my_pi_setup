# Keep new-session model

Keeps the current provider/model and thinking level when you use `/new`. It does not change your global defaults or override a resumed session's saved model.

The one-time handoff lives in process memory across Pi's extension reload during session replacement. No disk configuration, tools, or commands are added.

This preserves the behavior of the original personal `keep-new-session-model.ts` extension.
