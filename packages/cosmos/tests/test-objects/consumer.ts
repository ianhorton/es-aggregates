import { join, resolve } from "path";
import * as ts from "typescript";

/**
 * An app that uses the package, as TypeScript sees it. The app gets the declarations that
 * a build of src makes now, and not those that the last build has left.
 */
export class Consumer {
  private static readonly root = resolve(__dirname, "../..");

  private readonly declarations = new Map<string, string>();

  constructor() {
    const { options, fileNames } = ts.getParsedCommandLineOfConfigFile(
      join(Consumer.root, "tsconfig.json"),
      { emitDeclarationOnly: true },
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined }
    )!;
    ts.createProgram(fileNames, options).emit(undefined, (name, text) =>
      this.declarations.set(name, text)
    );
  }

  /**
   * What TypeScript finds wrong with an app that has this one file, and with the package's
   * declarations.
   *
   * @param name its extension tells the kind of module that the app is: mts or cts
   */
  public errorsOf = (
    name: string,
    source: string,
    skipLibCheck: boolean
  ): string[] => {
    const file = join(Consumer.root, "tests", name);
    const files = new Map([...this.declarations, [file, source]]);

    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.ES2020,
      strict: true,
      noEmit: true,
      skipLibCheck,
      types: ["node"],
      baseUrl: Consumer.root,
      paths: { "@es-aggregates/cosmos": ["dist/index.d.ts"] },
    };
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile } = host;
    host.fileExists = (path) => files.has(path) || fileExists(path);
    host.readFile = (path) => files.get(path) ?? readFile(path);
    host.directoryExists = undefined;

    const program = ts.createProgram([file], options, host);
    return [...files.keys()]
      .map((path) => program.getSourceFile(path))
      .filter((sourceFile): sourceFile is ts.SourceFile => !!sourceFile)
      .flatMap((sourceFile) => ts.getPreEmitDiagnostics(program, sourceFile))
      .map(({ messageText }) =>
        ts.flattenDiagnosticMessageText(messageText, "\n")
      );
  };
}
