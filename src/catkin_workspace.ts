
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'fast-glob';
import * as jsonfile from 'jsonfile';
import { Signal } from 'signals';
import * as vscode from 'vscode';
import { SourceFileConfiguration } from 'vscode-cpptools';
import { CatkinPackage } from './catkin_package';
import { runCatkinCommand, ShellOutput } from './catkin_command';
import { CatkinTestAdapter } from './catkin_test_adapter';
import { status_bar_profile, status_bar_profile_prefix, reloadAllWorkspaces } from './catkin_tools';

export class CatkinWorkspace {
  public compile_commands: Map<string, JSON> = new Map<string, JSON>();
  public file_to_command: Map<string, JSON> = new Map<string, JSON>();
  public file_to_compile_commands: Map<string, string> =
    new Map<string, string>();
  private watchers: Map<string, fs.FSWatcher> = new Map<string, fs.FSWatcher>();

  public system_include_browse_paths = [];
  public default_system_include_paths = [];

  private build_dir: string = null;
  private ignore_missing_db = false;
  private is_initialized = false;

  private catkin_profile: string = null;
  private catkin_config = new Map<string, string>();
  private catkin_src_dir: string = null;
  private catkin_build_dir: string = null;
  private catkin_devel_dir: string = null;
  private catkin_install_dir: string = null;

  public build_commands_changed: Signal = new Signal();
  public system_paths_changed: Signal = new Signal();

  public packages = new Map<string, CatkinPackage>();

  public test_adapter: CatkinTestAdapter = null;

  public onWorkspaceInitialized = new vscode.EventEmitter<boolean>();
  public onTestsSetChanged = new vscode.EventEmitter<boolean>();

  constructor(
    public associated_workspace_for_tasks: vscode.WorkspaceFolder,
    public output_channel: vscode.OutputChannel) {
  }

  dispose() { }

  public isInitialized() {
    return this.is_initialized;
  }

  public async reload(): Promise<CatkinWorkspace> {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Loading catkin workspace '${await this.getName()}'`,
      cancellable: false
    }, async (progress, token) => {
      this.loadCatkinConfig();

      this.output_channel.appendLine(`Reload ${await this.getName()}`);

      progress.report({ increment: 0, message: "Clearing caches" });

      for (var key in this.watchers.keys()) {
        this.watchers.get(key).close();
      }
      this.watchers.clear();
      this.compile_commands.clear();
      this.file_to_command.clear();
      this.file_to_compile_commands.clear();
      this.system_include_browse_paths = [];
      this.default_system_include_paths = [];

      this.packages.clear();

      this.build_commands_changed.dispatch();

      try {
        await this.loadAndWatchCompileCommands();
      } catch (error) {
        vscode.window.showErrorMessage(`cannot load workspace folder: ${error.command} failed with ${error.error.message}`);
        return;
      }

      progress.report({ increment: 1, message: "Searching packages" });
      const packages = await vscode.workspace.findFiles("**/package.xml");
      let range_progress_packages_min = 1;
      let range_progress_packages_max = 99;
      let accumulated_progress = 0.0;
      let progress_relative = (1.0 / packages.length) *
        (range_progress_packages_max - range_progress_packages_min);

      for (let package_xml of packages) {
        if (token.isCancellationRequested) {
          break;
        }
        accumulated_progress += progress_relative;
        if (accumulated_progress > 1.0) {
          let integer_progress = Math.floor(accumulated_progress);
          accumulated_progress -= integer_progress;
          progress.report({
            increment: integer_progress,
            message: `Parsing ${path.basename(path.dirname(package_xml.path))}`
          });
        }
        try {
          await this.loadPackage(package_xml.fsPath);

        } catch (error) {
          vscode.window.showErrorMessage(`Cannot load package: ${package_xml.fsPath} failed with ${error}`);
        }
      }
      progress.report({ increment: 1, message: "Building depency graph" });
      await this.buildDependencyGraph();

      this.is_initialized = true;
      progress.report({ increment: 100, message: "Finalizing" });

      this.output_channel.appendLine(`Done loading folder ${await this.getName()} / ${await this.getRootPath()}`);

      this.onWorkspaceInitialized.fire(true);

      return this;
    });
  }

  public async loadPackage(package_xml: fs.PathLike) {
    try {
      let catkin_package = await CatkinPackage.loadFromXML(package_xml, this);
      this.packages.set(catkin_package.getName(), catkin_package);
      return catkin_package;
    } catch (err) {
      console.error(`Error parsing package ${package_xml}: ${err}`);
      return null;
    }
  }

  public async locatePackageXML(package_name: String) {
    const packages = await vscode.workspace.findFiles("**/package.xml");
    for (let package_xml of packages) {
      let name = await CatkinPackage.getNameFromPackageXML(package_xml.fsPath);
      if (name === package_name) {
        return package_xml;
      }
    }
    return null;
  }

  public async buildDependencyGraph() {
    for (const [_, catkin_package] of this.packages) {
      for (const depency of catkin_package.dependencies) {
        let pkg = this.getPackage(depency);
        if (pkg !== undefined) {
          pkg.dependees.push(catkin_package.getName());
        }
      }
    }
  }

  public async iteratePossibleSourceFiles(
    file: vscode.Uri,
    async_filter: (uri: vscode.Uri) => Promise<boolean>
  ): Promise<boolean> {
    let checked_pkgs = [];
    const owner_package = this.getPackageContaining(file);
    if (owner_package !== undefined) {
      console.log(`Package ${await owner_package.getRelativePath()} owns file ${file.toString()}.`);
      const stop = await owner_package.iteratePossibleSourceFiles(file, async_filter);
      if (stop) {
        return true;
      }
      checked_pkgs.push(owner_package.getName());
      console.log(`Package ${await owner_package.getRelativePath()} does not use file ${file.toString()}.`);

      const found_match = await this.iterateDependentPackages(owner_package, async (dependent_package: CatkinPackage) => {
        if (checked_pkgs.findIndex(e => e === dependent_package.getName()) < 0) {
          const stop = await dependent_package.iteratePossibleSourceFiles(file, async_filter);
          if (stop) {
            return true;
          }
          checked_pkgs.push(dependent_package.getName());
        }

        console.log(`No usage of ${file.toString()} found.`);
        return false;
      });
      if(found_match) {
        return true;
      }
    }
    console.log(`No dependee of ${file.fsPath.toString()} uses the file.`);
    return false;
  }

  public async iterateDependentPackages(
    catkin_package: CatkinPackage,
    async_filter: (catkin_package: CatkinPackage) => Promise<boolean>
  ): Promise<boolean> {
    let checked_pkgs = new Set<string>();
    let unchecked_pkgs = [];
    for (const dep_name of catkin_package.dependees) {
      unchecked_pkgs.push(dep_name);
    }

    while (unchecked_pkgs.length > 0) {
      let dep_name = unchecked_pkgs[0];
      unchecked_pkgs = unchecked_pkgs.slice(1);
      if (!checked_pkgs.has(dep_name)) {
        // do the check
        checked_pkgs.add(dep_name);
        const dependency = this.getPackage(dep_name);
        if (dependency !== undefined) {
          console.log(`Checking ${dependency.name}`);
          let stop = await async_filter(dependency);
          if (stop) {
            return true;
          }
          for (const dep_name of dependency.dependees) {
            unchecked_pkgs.push(dep_name);
          }
        }
      }
    }
    return false;
  }

  public getSourceFileConfiguration(commands): SourceFileConfiguration {
    let args = commands.command.split(' ');

    let compiler = args[0];
    let includePaths = [];
    let defines = [];

    if (this.default_system_include_paths.length === 0) {
      this.parseCompilerDefaults(compiler, args.slice(1));
    }

    this.output_channel.appendLine(`Analyzing ${commands.command}`);

    // Parse the includes and defines from the compile commands
    let new_system_path_found = false;
    for (let i = 1; i < args.length; ++i) {
      let opt = args[i];
      this.output_channel.appendLine(`-${opt}`);
      if (opt.startsWith('-I')) {
        let path = opt.slice(2);
        this.output_channel.appendLine(`   -> add path ${path}`);
        includePaths.push(path);
        if (!this.isWorkspacePath(path)) {
          if (this.system_include_browse_paths.indexOf(path) < 0) {
            this.output_channel.appendLine(`   -> add system_include_browse_path ${path}`);
            this.system_include_browse_paths.push(path);
            new_system_path_found = true;
          }
        }
      } else if (opt === '-isystem') {
        ++i;
        let path = args[i];
        this.output_channel.appendLine(`   -> add system path ${path}`);
        includePaths.push(path);
        if (!this.isWorkspacePath(path)) {
          if (this.system_include_browse_paths.indexOf(path) < 0) {
            this.output_channel.appendLine(`   -> add system_include_browse_path ${path}`);
            this.system_include_browse_paths.push(path);
            new_system_path_found = true;
          }
        }
      } else if (opt.startsWith('-isystem=')) {
        let path = opt.slice(9);
        this.output_channel.appendLine(`   -> add system path ${path}`);
        includePaths.push(path);
        if (!this.isWorkspacePath(path)) {
          if (this.system_include_browse_paths.indexOf(path) < 0) {
            this.output_channel.appendLine(`   -> add system_include_browse_path ${path}`);
            this.system_include_browse_paths.push(path);
            new_system_path_found = true;
          }
        }
      } else if (opt.startsWith('-D')) {
        let define = opt.slice(2).replace(/\\/g, "");
        defines.push(define);
        this.output_channel.appendLine(`   -> add define ${define}`);
      }
    }
    if (new_system_path_found) {
      this.system_paths_changed.dispatch();
    }

    for (var dir of this.default_system_include_paths) {
      includePaths.push(dir);
    }

    // Construct the combined source file configuration
    let config = vscode.workspace.getConfiguration('catkin_tools');
    const ret: SourceFileConfiguration = {
      standard: config['cppStandard'],
      intelliSenseMode: config['intelliSenseMode'],
      includePath: includePaths,
      defines: defines,
      compilerPath: compiler,
    };
    return ret;
  }

  private isWorkspacePath(path: string): boolean {
    for (var ws of vscode.workspace.workspaceFolders) {
      let base = ws.uri.fsPath;
      if (!base.endsWith('/')) {
        base += '/';
      }
      base += 'src';
      if (path.startsWith(base)) {
        return true;
      }
    }
    return false;
  }

  private getPackage(name: string): CatkinPackage {
    return this.packages.get(name);
  }

  public getPackageContaining(file: vscode.Uri): CatkinPackage {
    for (let [_, pkg] of this.packages) {
      if (pkg.containsFile(file)) {
        return pkg;
      }
    }
    return undefined;
  }

  private parseCompilerDefaults(compiler: string, args: string[]) {
    this.default_system_include_paths = [];

    let compiler_path = compiler.split('/');
    let compiler_name = compiler_path[compiler_path.length - 1];

    if (compiler_name === 'nvcc') {
      this.parseCompilerDefaultsNvcc(compiler);
    } if (compiler_name.indexOf('ccache') >= 0) {
      this.parseCompilerDefaultsCcache(compiler, args);
    } else {
      this.parseCompilerDefaultsCpp(compiler);
    }

    this.system_paths_changed.dispatch();
  }

  private parseCompilerDefaultsCpp(compiler: string) {
    // Parse the default includes by invoking the compiler
    let options:
      child_process.ExecSyncOptionsWithStringEncoding = { 'encoding': 'utf8' };
    let stdout = child_process.execSync(
      compiler + ' -xc++ -E -v /dev/null -o /dev/null 2>&1', options);
    let private_includes = false;
    let public_includes = false;
    for (var line of stdout.split('\n')) {
      console.log(line);
      if (line.match('#include ".*starts here')) {
        private_includes = true;
        public_includes = false;
        continue;
      } else if (line.match('#include <.*starts here')) {
        private_includes = false;
        public_includes = true;
        continue;
      }
      if (line.match('End of search list')) {
        private_includes = false;
        public_includes = false;
        continue;
      }

      if (private_includes || public_includes) {
        this.default_system_include_paths.push(line.trim());
      }
    }
  }

  private parseCompilerDefaultsCcache(caching_compiler: string, args: string[]) {
    if (args.length === 0) {
      console.log(`Cannot determine defaults for compiler ${caching_compiler} without any further arguments}`);
      return;
    }
    console.log(`Defering default flags from cached compiler ${caching_compiler} to ${args[0]}`);
    this.parseCompilerDefaults(args[0], args.slice(1));
  }

  private parseCompilerDefaultsNvcc(compiler: string) {
    // Parse the default includes by invoking the compiler
    let options:
      child_process.ExecSyncOptionsWithStringEncoding = { 'encoding': 'utf8' };
    try {
      child_process.execSync(compiler + ' --dryrun -v /dev/null 1>&2', options);
    } catch (err) {
      for (var line of err.message.split('\n')) {
        let match = line.match(/^#\$ INCLUDES="(.*)"\s*$/);
        if (match) {
          for (let path of match[1].split("-I")) {
            let trimmed = path.trim();
            if (trimmed.length > 0) {
              this.default_system_include_paths.push(trimmed);
            }
          }
        }
      }
    }
  }

  private async updateDatabase(db_file: string): Promise<boolean> {
    console.log('updating with file', db_file);
    if (!fs.existsSync(db_file)) {
      console.log(`${db_file} does not exist anymore`);
      for (let [file, db] of this.file_to_compile_commands.entries()) {
        if (db === db_file) {
          this.file_to_command.delete(file);
          this.file_to_compile_commands.delete(file);
        }
      }
      this.build_commands_changed.dispatch();
      return true;
    }

    let db_part = await jsonfile.readFile(db_file);
    this.compile_commands.set(db_file, db_part);
    let change = false;
    for (var index in db_part) {
      let cmd = db_part[index];
      const file = cmd['file'];
      if (this.file_to_command.get(file) !== cmd) {
        this.file_to_command.set(file, cmd);
        change = true;
        this.file_to_compile_commands.set(file, db_file);
      }
    }
    if (change) {
      console.log('Signalling change in config');
      this.build_commands_changed.dispatch();
    }
    return change;
  }

  private async loadAndWatchCompileCommands() {
    let build_dir = await this.getBuildDir();
    if (build_dir === null) {
      vscode.window.showErrorMessage('Cannot determine build directory');
      return;
    }
    let db_found = false;
    if (fs.existsSync(build_dir)) {
      if (this.build_dir !== build_dir) {
        this.build_dir = build_dir;

        fs.watch(build_dir, async (eventType, filename) => {
          let abs_file = this.build_dir + '/' + filename;
          if (eventType === 'rename') {
            if (fs.existsSync(abs_file)) {
              if (fs.lstatSync(abs_file).isDirectory()) {
                // new package created
                this.startWatchingCatkinPackageBuildDir(abs_file);
                console.log(`New package ${filename}`);

                this.test_adapter.signalReload();
                let package_xml = await this.locatePackageXML(filename);
                let catkin_package = await this.loadPackage(package_xml.fsPath);
                if (catkin_package && catkin_package.has_tests) {
                  let suite = await this.test_adapter.updatePackageTests(catkin_package, true);
                  this.test_adapter.updateSuiteSet();
                  console.log(`New package ${catkin_package.name} found and ${suite.executables === null ? "unknown" : suite.executables.length} tests added`);
                } else {
                  console.log(`New package ${catkin_package.name} but no package.xml found`);
                }
              }
            } else {
              // package cleaned
              console.log('Package', filename, 'was cleaned');
              this.stopWatching(abs_file);
            }
          }
        });
      }

      let expr = this.build_dir + '/**/compile_commands.json';

      const entries = await glob.async([expr]);
      for (let file of entries) {
        this.startWatchingCompileCommandsFile(file.toString());
      }
      db_found = entries.length !== 0;
    }

    if (!db_found && !this.ignore_missing_db) {
      let ask_trigger_build = !db_found;
      let args = await this.getConfigEntry("Additional CMake Args");
      if (args.indexOf("CMAKE_EXPORT_COMPILE_COMMANDS") < 0) {
        const ignore = {
          title: "Ignore this"
        };
        const update = {
          title: "Update catkin config"
        };
        let result = await vscode.window.showWarningMessage(
          `CMAKE_EXPORT_COMPILE_COMMANDS is not enabled in your catkin configuration.`,
          {},
          ignore, update);

        if (result === ignore) {
          this.ignore_missing_db = true;
          return;
        } else if (result === update) {
          this.enableCompileCommandsGeneration();
          ask_trigger_build = true;
        }
      }

      if (ask_trigger_build) {
        const ignore = {
          title: "Ignore this"
        };
        const build = {
          title: "Build workspace"
        };
        let build_tasks = await vscode.tasks.fetchTasks({
          type: "catkin_build"
        });
        let build_task: vscode.Task;
        let items = [ignore];
        if (build_tasks !== undefined && build_tasks.length > 0) {
          for (let task of build_tasks) {
            if (task.name === "build" && task.scope === this.associated_workspace_for_tasks) {
              build_task = task;
              items.push(build);
              break;
            }
          }
        }
        let result = await vscode.window.showWarningMessage(
          `No compile_commands.json files found in ${this.build_dir}.\n` +
          `Please build your workspace to generate the files.`,
          {},
          ...items);
        if (result === ignore) {
          this.ignore_missing_db = true;
        } else if (result === build) {
          vscode.tasks.executeTask(build_task);
        }
      }
      return;
    }

  }

  public async getConfigEntry(key: string): Promise<string> {
    if (this.catkin_config.size === 0) {
      await this.loadCatkinConfig();
    }
    return this.catkin_config.get(key);
  }

  public async getRootPath(): Promise<fs.PathLike> {
    return this.getConfigEntry('Workspace');
  }

  public async getName(): Promise<string> {
    let root_path = await this.getRootPath();
    return path.basename(root_path.toString());
  }

  public async getProfile(): Promise<[string, string[]]> {
    const root_path = await this.getRootPath();
    let profile_base_path = path.join(root_path.toString(), ".catkin_tools/profiles");

    let profiles_path = path.join(profile_base_path, "profiles.yaml");
    if (!fs.existsSync(profiles_path)) {
      // profiles.yaml is only generated when there is more than one profile available
      // if it does not exist, then the `default` profile is used
      return ['default', []];
    }

    const configs = await glob.async([profile_base_path + '/**/config.yaml']);
    const profiles = configs.map((yaml) => path.basename(path.dirname(yaml.toString())));

    const content_raw = await fs.promises.readFile(profiles_path);
    const content = content_raw.toString();
    for (let row of content.split('\n')) {
      let active = row.match(RegExp('active:\s*(.*)'));
      if (active) {
        return [active[1].trim(), profiles];
      }
    }

    return [null, []];
  }

  public async switchProfile(profile) {
    const root_path = await this.getRootPath();
    runCatkinCommand(['profile', 'set', profile], root_path);
    await this.checkProfile();
  }


  public async checkProfile() {
    let [profile, _] = await this.getProfile();
    if (this.catkin_profile !== profile) {
      await this.updateProfile(profile);
    }
  }

  private async updateProfile(profile) {
    console.log(`PROFILE: Switching to ${profile}`);
    this.catkin_profile = profile;
    this.catkin_src_dir = null;
    this.catkin_build_dir = null;
    this.catkin_devel_dir = null;
    this.catkin_install_dir = null;

    status_bar_profile.text = status_bar_profile_prefix + profile;

    await this.reload();
  }

  private async loadCatkinConfig() {
    const output = await runCatkinCommand(['config'], this.associated_workspace_for_tasks.uri.fsPath);

    this.catkin_config.clear();
    for (const line of output.stdout.split("\n")) {
      if (line.indexOf(":") > 0) {
        const [key, val] = line.split(":").map(s => s.trim());
        console.log(key, val);
        this.catkin_config.set(key, val);
      }
    }
  }

  public async getSrcDir(): Promise<string> {
    await this.checkProfile();
    if (this.catkin_src_dir === null) {
      const output: ShellOutput = await runCatkinCommand(['locate', '-s'], await this.getRootPath());
      this.catkin_src_dir = output.stdout.split('\n')[0];
    }
    return this.catkin_src_dir;
  }
  public async getBuildDir(): Promise<string> {
    await this.checkProfile();
    if (this.catkin_build_dir === null) {
      const output: ShellOutput = await runCatkinCommand(['locate', '-b'], await this.getRootPath());
      this.catkin_build_dir = output.stdout.split('\n')[0];
      if (this.catkin_build_dir.endsWith("/")) {
        this.catkin_build_dir = this.catkin_build_dir.slice(0, -1);
      }
    }
    return this.catkin_build_dir;
  }
  public async getDevelDir(): Promise<string> {
    await this.checkProfile();
    if (this.catkin_devel_dir === null) {
      const output: ShellOutput = await runCatkinCommand(['locate', '-d'], await this.getRootPath());
      this.catkin_devel_dir = output.stdout.split('\n')[0];
      if (this.catkin_devel_dir.endsWith("/")) {
        this.catkin_devel_dir = this.catkin_devel_dir.slice(0, -1);
      }
    }
    return this.catkin_devel_dir;
  }
  public async getInstallDir(): Promise<string> {
    await this.checkProfile();
    if (this.catkin_install_dir === null) {
      const output: ShellOutput = await runCatkinCommand(['locate', '-i'], await this.getRootPath());
      this.catkin_install_dir = output.stdout.split('\n')[0];
      if (this.catkin_install_dir.endsWith("/")) {
        this.catkin_install_dir = this.catkin_install_dir.slice(0, -1);
      }
    }
    return this.catkin_install_dir;
  }

  public async getSetupShell(): Promise<string> {
    const config = vscode.workspace.getConfiguration('catkin_tools');
    const install_dir = await this.getInstallDir();
    let setup = install_dir + `/setup.${config['shell']}`;
    if (fs.existsSync(setup)) {
      return setup;
    }
    const devel_dir = await this.getDevelDir();
    return devel_dir + `/setup.${config['shell']}`;
  }

  private startWatchingCatkinPackageBuildDir(file: string) {
    console.log('watching directory', file);
    this.stopWatching(file);
    this.watchers.set(file, fs.watch(file, (eventType, filename) => {
      if (filename === 'compile_commands.json') {
        console.log(
          'File', filename, 'in package', file, 'changed with', eventType);
        let db_file = file + '/' + filename;
        if (fs.existsSync(db_file)) {
          this.startWatchingCompileCommandsFile(db_file);
        }
      }
    }));
  }

  private stopWatching(file: string) {
    if (this.watchers.has(file)) {
      console.log('stop watching', file);
      this.watchers.get(file).close();
      this.watchers.delete(file);
    }
  }

  private startWatchingCompileCommandsFile(file: string) {
    this.updateDatabase(file);
    console.log('watching file', file);
    this.stopWatching(file);
    this.watchers.set(file, fs.watch(file, (eventType, filename) => {
      if (filename) {
        console.log('Database file', file, 'changed');
        this.updateDatabase(file);
      }
    }));
  }

  private async enableCompileCommandsGeneration() {
    const cmake_opts = await this.getConfigEntry("Additional CMake Args");
    runCatkinCommand(['config', '--cmake-args', `${cmake_opts} -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`], await this.getRootPath());
    this.loadCatkinConfig();
  }

  public async makeCommand(payload: string) {
    const setup_shell = await this.getSetupShell();
    let command = `source ${setup_shell} > /dev/null 2>&1;`;
    command += `pushd . > /dev/null; cd "${await this.getRootPath()}";`;
    command += `${payload}`;
    if (!payload.endsWith(";")) {
      command += "; ";
    }
    command += "EXIT_CODE=$?; ";
    command += `popd > /dev/null; [ "$EXIT_CODE" = "0" ] || exit $EXIT_CODE;`;
    return command;
  }
}