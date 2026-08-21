import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * An fs-like resolver that postman-runtime uses for `body.mode: 'file'` and
 * form-data file entries, jailed to the workspace.
 *
 * Modelled on newman's `lib/run/secure-fs.js`, but rooted at the VS Code
 * workspace rather than the process cwd. A collection is untrusted input — it
 * can name any path it likes — so every read is resolved and re-checked
 * against the jail before it is allowed.
 *
 * A workspace is a *set* of folders, and the two roles that set plays are
 * different. `base` is the one folder a relative path is relative to: the
 * folder the collection being run lives in, because that is what its author
 * wrote the path against. `roots` is every folder the workspace has, because a
 * request may legitimately read a fixture out of a sibling folder the user
 * added on purpose. Anything outside all of them is still refused.
 */
export class WorkspaceFileResolver {
  private readonly roots: string[];

  constructor(private readonly base: string | undefined, roots?: readonly string[]) {
    // A single-root caller can pass just the base and get the old behaviour.
    this.roots = roots?.length ? [...roots] : base ? [base] : [];
  }

  private resolve(target: string): string {
    if (!this.base || !this.roots.length) {
      throw new Error('No workspace folder is open, so files cannot be read.');
    }
    const abs = path.resolve(this.base, target);
    const allowed = this.roots.some((root) => {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
    if (!allowed) {
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
