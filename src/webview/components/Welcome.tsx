interface Props {
  logoUri: string;
}

export function Welcome({ logoUri }: Props) {
  return (
    <div class="welcome">
      <img src={logoUri} alt="" class="welcome-logo" />
      <h3>Majestix AI</h3>
      <p>
        Agentic coding assistant — reads files, writes code, runs commands.<br />
        Select a mode above, then describe your task.<br />
        <kbd>Cmd+Shift+I</kbd> to ask from anywhere.
      </p>
    </div>
  );
}
