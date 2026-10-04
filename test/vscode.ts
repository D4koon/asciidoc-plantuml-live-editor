// Stand-in for the `vscode` module in tests: only the Uri value type.
import { URI, Utils } from 'vscode-uri';

export class Uri extends URI {
  static joinPath(base: URI, ...segments: string[]): URI {
    return Utils.joinPath(base, ...segments);
  }
}
