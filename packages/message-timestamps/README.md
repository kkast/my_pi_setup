# Message timestamps

Adds a small GMT+3 timestamp line after each user message, assistant message, and visible custom message in Pi's interactive transcript. Assistant tool calls get one assistant timestamp; tool results do not get a second timestamp. Timestamp entries are TUI-only custom entries: they are saved for session resume but **not sent to the model or added to its prompt**. Existing messages from before installation are unchanged.

Pi does not expose a built-in message-bubble timestamp decorator, so the label appears on its own subdued line after the message. The extension waits until the message is saved before adding its timestamp, keeping transcript order correct.
