import * as vscode from "vscode";

const SECRET_KEY = "majestix.apiKey";

/**
 * Manages the Majestix API key stored in VSCode's SecretStorage (OS keychain).
 */
export class ApiKeyManager {
  /**
   * Creates an ApiKeyManager backed by VSCode's secret storage.
   *
   * @param secrets - The VSCode SecretStorage instance used to persist the API key.
   */
  constructor(private secrets: vscode.SecretStorage) {}

  /**
   * Retrieves the stored API key.
   *
   * @returns The stored API key string, or undefined if none has been set.
   */
  async getKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  /**
   * Stores the given API key in secret storage.
   *
   * @param key - The API key string to persist.
   */
  async setKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, key);
  }

  /**
   * Removes the stored API key from secret storage.
   */
  async clearKey(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }

  /**
   * Checks whether an API key is currently stored.
   *
   * @returns True if an API key exists in storage, false otherwise.
   */
  async hasKey(): Promise<boolean> {
    const key = await this.getKey();
    return key !== undefined && key.length > 0;
  }

  /**
   * Prompt the user to enter an API key. Opens an input box.
   * Returns the key that was saved, or undefined if the user cancelled.
   *
   * @returns The API key string if the user entered and saved one, or undefined if cancelled.
   */
  async promptForKey(): Promise<string | undefined> {
    const key = await vscode.window.showInputBox({
      title: "Majestix AI — API Key",
      prompt:
        "Paste your API key from the Majestix web dashboard (Settings → API Keys)",
      placeHolder: "inf_...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value.startsWith("inf_")) {
          return "API key must start with 'inf_'";
        }
        if (value.length < 20) {
          return "API key is too short";
        }
        return null;
      },
    });

    if (key !== undefined && key.length > 0) {
      await this.setKey(key);
      void vscode.window.showInformationMessage("Majestix AI: API key saved.");
      return key;
    }
    return undefined;
  }

  /**
   * Ensure we have an API key, prompting if needed.
   * Returns the key or undefined if the user cancelled.
   *
   * @returns The API key string if available or just set, or undefined if the user cancelled.
   */
  async requireKey(): Promise<string | undefined> {
    const key = await this.getKey();
    if (key !== undefined && key.length > 0) {return key;}
    return this.promptForKey();
  }
}
