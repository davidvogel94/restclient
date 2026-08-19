import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * An fs-like resolver that postman-runtime uses for `body.mode: 'file'` and
 * form-data file entries, jailed to the workspace root.
 *
 * Modelled on newman's `lib/run/secure-fs.js`, but rooted at the VS Code
 * workspace rather than the process cwd. A collection is untrusted input — it
 * can name any path it likes — so every read is resolved and re-checked
 * against the root before it is allowed.
 */
export class WorkspaceFileResolver {
  constructor(private readonly root: string | undefined) {}

  private resolve(target: string): string {
    if (!this.root) {
      throw new Error('No workspace folder is open, so files cannot be read.');
    }
    const abs = path.resolve(this.root, target);
    const rel = path.relative(this.root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to read "${target}": outside the workspace folder.`);
    }
    return abs;
  }

  stat = (
    target: string,
    cb: (err: NodeJS.ErrnoException | Error | null, stats?: fs.Stats) => void
  ): void => {
    let abs: string;
    try {
      abs = this.resolve(target);
    } catch (e) {
      return cb(e as Error);
    }
    fs.stat(abs, cb);
  };

  createReadStream = (target: string): fs.ReadStream => {
    // Throws synchronously on a jail violation; postman-runtime surfaces it as
    // a request error, which is what we want the user to see.
    return fs.createReadStream(this.resolve(target));
  };
}
