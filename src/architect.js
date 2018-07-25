"use strict";
/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@angular-devkit/core");
const node_1 = require("@angular-devkit/core/node");
const rxjs_1 = require("rxjs");
const operators_1 = require("rxjs/operators");
class ProjectNotFoundException extends core_1.BaseException {
    constructor(projectName) {
        super(`Project '${projectName}' could not be found in Workspace.`);
    }
}
exports.ProjectNotFoundException = ProjectNotFoundException;
class TargetNotFoundException extends core_1.BaseException {
    constructor(projectName, targetName) {
        super(`Target '${targetName}' could not be found in project '${projectName}'.`);
    }
}
exports.TargetNotFoundException = TargetNotFoundException;
class ConfigurationNotFoundException extends core_1.BaseException {
    constructor(projectName, configurationName) {
        super(`Configuration '${configurationName}' could not be found in project '${projectName}'.`);
    }
}
exports.ConfigurationNotFoundException = ConfigurationNotFoundException;
// TODO: break this exception apart into more granular ones.
class BuilderCannotBeResolvedException extends core_1.BaseException {
    constructor(builder) {
        super(`Builder '${builder}' cannot be resolved.`);
    }
}
exports.BuilderCannotBeResolvedException = BuilderCannotBeResolvedException;
class ArchitectNotYetLoadedException extends core_1.BaseException {
    constructor() { super(`Architect needs to be loaded before Architect is used.`); }
}
exports.ArchitectNotYetLoadedException = ArchitectNotYetLoadedException;
class BuilderNotFoundException extends core_1.BaseException {
    constructor(builder) {
        super(`Builder ${builder} could not be found.`);
    }
}
exports.BuilderNotFoundException = BuilderNotFoundException;
class Architect {
    constructor(_workspace) {
        this._workspace = _workspace;
        this._targetsSchemaPath = core_1.join(core_1.normalize(__dirname), 'targets-schema.json');
        this._buildersSchemaPath = core_1.join(core_1.normalize(__dirname), 'builders-schema.json');
        this._architectSchemasLoaded = false;
        this._targetMapMap = new Map();
        this._builderPathsMap = new Map();
        this._builderDescriptionMap = new Map();
        this._builderConstructorMap = new Map();
    }
    loadArchitect() {
        if (this._architectSchemasLoaded) {
            return rxjs_1.of(this);
        }
        else {
            return rxjs_1.forkJoin(this._loadJsonFile(this._targetsSchemaPath), this._loadJsonFile(this._buildersSchemaPath)).pipe(operators_1.concatMap(([targetsSchema, buildersSchema]) => {
                this._targetsSchema = targetsSchema;
                this._buildersSchema = buildersSchema;
                this._architectSchemasLoaded = true;
                // Validate and cache all project target maps.
                return rxjs_1.forkJoin(...this._workspace.listProjectNames().map(projectName => {
                    const unvalidatedTargetMap = this._workspace.getProjectTargets(projectName);
                    return this._workspace.validateAgainstSchema(unvalidatedTargetMap, this._targetsSchema).pipe(operators_1.tap(targetMap => this._targetMapMap.set(projectName, targetMap)));
                }));
            }), operators_1.map(() => this));
        }
    }
    listProjectTargets(projectName) {
        return Object.keys(this._getProjectTargetMap(projectName));
    }
    _getProjectTargetMap(projectName) {
        if (!this._targetMapMap.has(projectName)) {
            throw new ProjectNotFoundException(projectName);
        }
        return this._targetMapMap.get(projectName);
    }
    _getProjectTarget(projectName, targetName) {
        const targetMap = this._getProjectTargetMap(projectName);
        const target = targetMap[targetName];
        if (!target) {
            throw new TargetNotFoundException(projectName, targetName);
        }
        return target;
    }
    getBuilderConfiguration(targetSpec) {
        const { project: projectName, target: targetName, configuration: configurationName, overrides, } = targetSpec;
        const project = this._workspace.getProject(projectName);
        const target = this._getProjectTarget(projectName, targetName);
        const options = target.options;
        let configuration = {};
        if (configurationName) {
            if (!target.configurations) {
                throw new ConfigurationNotFoundException(projectName, configurationName);
            }
            configuration = target.configurations[configurationName];
            if (!configuration) {
                throw new ConfigurationNotFoundException(projectName, configurationName);
            }
        }
        const builderConfiguration = {
            root: project.root,
            sourceRoot: project.sourceRoot,
            projectType: project.projectType,
            builder: target.builder,
            options: Object.assign({}, options, configuration, overrides),
        };
        return builderConfiguration;
    }
    run(builderConfig, partialContext = {}) {
        const context = Object.assign({ logger: new core_1.logging.NullLogger(), architect: this, host: this._workspace.host, workspace: this._workspace }, partialContext);
        let builderDescription;
        return this.getBuilderDescription(builderConfig).pipe(operators_1.tap(description => builderDescription = description), operators_1.concatMap(() => this.validateBuilderOptions(builderConfig, builderDescription)), operators_1.tap(validatedBuilderConfig => builderConfig = validatedBuilderConfig), operators_1.map(() => this.getBuilder(builderDescription, context)), operators_1.concatMap(builder => builder.run(builderConfig)));
    }
    getBuilderDescription(builderConfig) {
        // Check cache for this builder description.
        if (this._builderDescriptionMap.has(builderConfig.builder)) {
            return rxjs_1.of(this._builderDescriptionMap.get(builderConfig.builder));
        }
        return new rxjs_1.Observable((obs) => {
            // TODO: this probably needs to be more like NodeModulesEngineHost.
            const basedir = core_1.getSystemPath(this._workspace.root);
            const [pkg, builderName] = builderConfig.builder.split(':');
            const pkgJsonPath = node_1.resolve(pkg, { basedir, resolvePackageJson: true, checkLocal: true });
            let buildersJsonPath;
            let builderPaths;
            // Read the `builders` entry of package.json.
            return this._loadJsonFile(core_1.normalize(pkgJsonPath)).pipe(operators_1.concatMap((pkgJson) => {
                const pkgJsonBuildersentry = pkgJson['builders'];
                if (!pkgJsonBuildersentry) {
                    return rxjs_1.throwError(new BuilderCannotBeResolvedException(builderConfig.builder));
                }
                buildersJsonPath = core_1.join(core_1.dirname(core_1.normalize(pkgJsonPath)), pkgJsonBuildersentry);
                return this._loadJsonFile(buildersJsonPath);
            }), 
            // Validate builders json.
            operators_1.concatMap((builderPathsMap) => this._workspace.validateAgainstSchema(builderPathsMap, this._buildersSchema)), operators_1.concatMap((builderPathsMap) => {
                builderPaths = builderPathsMap.builders[builderName];
                if (!builderPaths) {
                    return rxjs_1.throwError(new BuilderCannotBeResolvedException(builderConfig.builder));
                }
                // Resolve paths in the builder paths.
                const builderJsonDir = core_1.dirname(buildersJsonPath);
                builderPaths.schema = core_1.join(builderJsonDir, builderPaths.schema);
                builderPaths.class = core_1.join(builderJsonDir, builderPaths.class);
                // Save the builder paths so that we can lazily load the builder.
                this._builderPathsMap.set(builderConfig.builder, builderPaths);
                // Load the schema.
                return this._loadJsonFile(builderPaths.schema);
            }), operators_1.map(builderSchema => {
                const builderDescription = {
                    name: builderConfig.builder,
                    schema: builderSchema,
                    description: builderPaths.description,
                };
                // Save to cache before returning.
                this._builderDescriptionMap.set(builderDescription.name, builderDescription);
                return builderDescription;
            })).subscribe(obs);
        });
    }
    validateBuilderOptions(builderConfig, builderDescription) {
        return this._workspace.validateAgainstSchema(builderConfig.options, builderDescription.schema).pipe(operators_1.map(validatedOptions => {
            builderConfig.options = validatedOptions;
            return builderConfig;
        }));
    }
    getBuilder(builderDescription, context) {
        const name = builderDescription.name;
        let builderConstructor;
        // Check cache for this builder.
        if (this._builderConstructorMap.has(name)) {
            builderConstructor = this._builderConstructorMap.get(name);
        }
        else {
            if (!this._builderPathsMap.has(name)) {
                throw new BuilderNotFoundException(name);
            }
            const builderPaths = this._builderPathsMap.get(name);
            // TODO: support more than the default export, maybe via builder#import-name.
            const builderModule = require(core_1.getSystemPath(builderPaths.class));
            builderConstructor = builderModule['default'];
            // Save builder to cache before returning.
            this._builderConstructorMap.set(builderDescription.name, builderConstructor);
        }
        const builder = new builderConstructor(context);
        return builder;
    }
    _loadJsonFile(path) {
        return this._workspace.host.read(core_1.normalize(path)).pipe(operators_1.map(buffer => core_1.virtualFs.fileBufferToString(buffer)), operators_1.map(str => core_1.parseJson(str, core_1.JsonParseMode.Loose)));
    }
}
exports.Architect = Architect;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXJjaGl0ZWN0LmpzIiwic291cmNlUm9vdCI6Ii4vIiwic291cmNlcyI6WyJwYWNrYWdlcy9hbmd1bGFyX2RldmtpdC9hcmNoaXRlY3Qvc3JjL2FyY2hpdGVjdC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOztBQUVILCtDQWE4QjtBQUM5QixvREFBbUU7QUFDbkUsK0JBQTREO0FBQzVELDhDQUFxRDtBQUVyRCw4QkFBc0MsU0FBUSxvQkFBYTtJQUN6RCxZQUFZLFdBQW1CO1FBQzdCLEtBQUssQ0FBQyxZQUFZLFdBQVcsb0NBQW9DLENBQUMsQ0FBQztJQUNyRSxDQUFDO0NBQ0Y7QUFKRCw0REFJQztBQUVELDZCQUFxQyxTQUFRLG9CQUFhO0lBQ3hELFlBQVksV0FBbUIsRUFBRSxVQUFrQjtRQUNqRCxLQUFLLENBQUMsV0FBVyxVQUFVLG9DQUFvQyxXQUFXLElBQUksQ0FBQyxDQUFDO0lBQ2xGLENBQUM7Q0FDRjtBQUpELDBEQUlDO0FBRUQsb0NBQTRDLFNBQVEsb0JBQWE7SUFDL0QsWUFBWSxXQUFtQixFQUFFLGlCQUF5QjtRQUN4RCxLQUFLLENBQUMsa0JBQWtCLGlCQUFpQixvQ0FBb0MsV0FBVyxJQUFJLENBQUMsQ0FBQztJQUNoRyxDQUFDO0NBQ0Y7QUFKRCx3RUFJQztBQUVELDREQUE0RDtBQUM1RCxzQ0FBOEMsU0FBUSxvQkFBYTtJQUNqRSxZQUFZLE9BQWU7UUFDekIsS0FBSyxDQUFDLFlBQVksT0FBTyx1QkFBdUIsQ0FBQyxDQUFDO0lBQ3BELENBQUM7Q0FDRjtBQUpELDRFQUlDO0FBRUQsb0NBQTRDLFNBQVEsb0JBQWE7SUFDL0QsZ0JBQWdCLEtBQUssQ0FBQyx3REFBd0QsQ0FBQyxDQUFDLENBQUMsQ0FBQztDQUNuRjtBQUZELHdFQUVDO0FBRUQsOEJBQXNDLFNBQVEsb0JBQWE7SUFDekQsWUFBWSxPQUFlO1FBQ3pCLEtBQUssQ0FBQyxXQUFXLE9BQU8sc0JBQXNCLENBQUMsQ0FBQztJQUNsRCxDQUFDO0NBQ0Y7QUFK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Q0FBQztnQkFDckMsTUFBTSxJQUFJLHdCQUF3QixDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzNDLENBQUM7WUFFRCxNQUFNLFlBQVksR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBaUIsQ0FBQztZQUVyRSw2RUFBNkU7WUFDN0UsTUFBTSxhQUFhLEdBQUcsT0FBTyxDQUFDLG9CQUFhLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7WUFDakUsa0JBQWtCLEdBQUcsYUFBYSxDQUFDLFNBQVMsQ0FBaUMsQ0FBQztZQUU5RSwwQ0FBMEM7WUFDMUMsSUFBSSxDQUFDLHNCQUFzQixDQUFDLEdBQUcsQ0FBQyxrQkFBa0IsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLENBQUMsQ0FBQztRQUMvRSxDQUFDO1FBRUQsTUFBTSxPQUFPLEdBQUcsSUFBSSxrQkFBa0IsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUVoRCxNQUFNLENBQUMsT0FBTyxDQUFDO0lBQ2pCLENBQUM7SUFFTyxhQUFhLENBQUMsSUFBVTtRQUM5QixNQUFNLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLGdCQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQ3BELGVBQUcsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLGdCQUFTLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsRUFDbkQsZUFBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsZ0JBQVMsQ0FBQyxHQUFHLEVBQUUsb0JBQWEsQ0FBQyxLQUFLLENBQXFCLENBQUMsQ0FDcEUsQ0FBQztJQUNKLENBQUM7Q0FDRjtBQXBQRCw4QkFvUEMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIEluYy4gQWxsIFJpZ2h0cyBSZXNlcnZlZC5cbiAqXG4gKiBVc2Ugb2YgdGhpcyBzb3VyY2UgY29kZSBpcyBnb3Zlcm5lZCBieSBhbiBNSVQtc3R5bGUgbGljZW5zZSB0aGF0IGNhbiBiZVxuICogZm91bmQgaW4gdGhlIExJQ0VOU0UgZmlsZSBhdCBodHRwczovL2FuZ3VsYXIuaW8vbGljZW5zZVxuICovXG5cbmltcG9ydCB7XG4gIEJhc2VFeGNlcHRpb24sXG4gIEpzb25PYmplY3QsXG4gIEpzb25QYXJzZU1vZGUsXG4gIFBhdGgsXG4gIGRpcm5hbWUsXG4gIGV4cGVyaW1lbnRhbCxcbiAgZ2V0U3lzdGVtUGF0aCxcbiAgam9pbixcbiAgbG9nZ2luZyxcbiAgbm9ybWFsaXplLFxuICBwYXJzZUpzb24sXG4gIHZpcnR1YWxGcyxcbn0gZnJvbSAnQGFuZ3VsYXItZGV2a2l0L2NvcmUnO1xuaW1wb3J0IHsgcmVzb2x2ZSBhcyBub2RlUmVzb2x2ZSB9IGZyb20gJ0Bhbmd1bGFyLWRldmtpdC9jb3JlL25vZGUnO1xuaW1wb3J0IHsgT2JzZXJ2YWJsZSwgZm9ya0pvaW4sIG9mLCB0aHJvd0Vycm9yIH0gZnJvbSAncnhqcyc7XG5pbXBvcnQgeyBjb25jYXRNYXAsIG1hcCwgdGFwIH0gZnJvbSAncnhqcy9vcGVyYXRvcnMnO1xuXG5leHBvcnQgY2xhc3MgUHJvamVjdE5vdEZvdW5kRXhjZXB0aW9uIGV4dGVuZHMgQmFzZUV4Y2VwdGlvbiB7XG4gIGNvbnN0cnVjdG9yKHByb2plY3ROYW1lOiBzdHJpbmcpIHtcbiAgICBzdXBlcihgUHJvamVjdCAnJHtwcm9qZWN0TmFtZX0nIGNvdWxkIG5vdCBiZSBmb3VuZCBpbiBXb3Jrc3BhY2UuYCk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIFRhcmdldE5vdEZvdW5kRXhjZXB0aW9uIGV4dGVuZHMgQmFzZUV4Y2VwdGlvbiB7XG4gIGNvbnN0cnVjdG9yKHByb2plY3ROYW1lOiBzdHJpbmcsIHRhcmdldE5hbWU6IHN0cmluZykge1xuICAgIHN1cGVyKGBUYXJnZXQgJyR7dGFyZ2V0TmFtZX0nIGNvdWxkIG5vdCBiZSBmb3VuZCBpbiBwcm9qZWN0ICcke3Byb2plY3ROYW1lfScuYCk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIENvbmZpZ3VyYXRpb25Ob3RGb3VuZEV4Y2VwdGlvbiBleHRlbmRzIEJhc2VFeGNlcHRpb24ge1xuICBjb25zdHJ1Y3Rvcihwcm9qZWN0TmFtZTogc3RyaW5nLCBjb25maWd1cmF0aW9uTmFtZTogc3RyaW5nKSB7XG4gICAgc3VwZXIoYENvbmZpZ3VyYXRpb24gJyR7Y29uZmlndXJhdGlvbk5hbWV9JyBjb3VsZCBub3QgYmUgZm91bmQgaW4gcHJvamVjdCAnJHtwcm9qZWN0TmFtZX0nLmApO1xuICB9XG59XG5cbi8vIFRPRE86IGJyZWFrIHRoaXMgZXhjZXB0aW9uIGFwYXJ0IGludG8gbW9yZSBncmFudWxhciBvbmVzLlxuZXhwb3J0IGNsYXNzIEJ1aWxkZXJDYW5ub3RCZVJlc29sdmVkRXhjZXB0aW9uIGV4dGVuZHMgQmFzZUV4Y2VwdGlvbiB7XG4gIGNvbnN0cnVjdG9yKGJ1aWxkZXI6IHN0cmluZykge1xuICAgIHN1cGVyKGBCdWlsZGVyICcke2J1aWxkZXJ9JyBjYW5ub3QgYmUgcmVzb2x2ZWQuYCk7XG4gIH1cbn1cblxuZXhwb3J0IGNsYXNzIEFyY2hpdGVjdE5vdFlldExvYWRlZEV4Y2VwdGlvbiBleHRlbmRzIEJhc2VFeGNlcHRpb24ge1xuICBjb25zdHJ1Y3RvcigpIHsgc3VwZXIoYEFyY2hpdGVjdCBuZWVkcyB0byBiZSBsb2FkZWQgYmVmb3JlIEFyY2hpdGVjdCBpcyB1c2VkLmApOyB9XG59XG5cbmV4cG9ydCBjbGFzcyBCdWlsZGVyTm90Rm91bmRFeGNlcHRpb24gZXh0ZW5kcyBCYXNlRXhjZXB0aW9uIHtcbiAgY29uc3RydWN0b3IoYnVpbGRlcjogc3RyaW5nKSB7XG4gICAgc3VwZXIoYEJ1aWxkZXIgJHtidWlsZGVyfSBjb3VsZCBub3QgYmUgZm91bmQuYCk7XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBCdWlsZGVyQ29udGV4dCB7XG4gIGxvZ2dlcjogbG9nZ2luZy5Mb2dnZXI7XG4gIGhvc3Q6IHZpcnR1YWxGcy5Ib3N0PHt9PjtcbiAgd29ya3NwYWNlOiBleHBlcmltZW50YWwud29ya3NwYWNlLldvcmtzcGFjZTtcbiAgYXJjaGl0ZWN0OiBBcmNoaXRlY3Q7XG59XG5cbi8vIFRPRE86IHVzZSBCdWlsZCBFdmVudCBQcm90b2NvbFxuLy8gaHR0cHM6Ly9kb2NzLmJhemVsLmJ1aWxkL3ZlcnNpb25zL21hc3Rlci9idWlsZC1ldmVudC1wcm90b2NvbC5odG1sXG4vLyBodHRwczovL2dpdGh1Yi5jb20vZ29vZ2xlYXBpcy9nb29nbGVhcGlzL3RyZWUvbWFzdGVyL2dvb2dsZS9kZXZ0b29scy9idWlsZC92MVxuZXhwb3J0IGludGVyZmFjZSBCdWlsZEV2ZW50IHtcbiAgc3VjY2VzczogYm9vbGVhbjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCdWlsZGVyPE9wdGlvbnNUPiB7XG4gIHJ1bihidWlsZGVyQ29uZmlnOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxQYXJ0aWFsPE9wdGlvbnNUPj4pOiBPYnNlcnZhYmxlPEJ1aWxkRXZlbnQ+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJ1aWxkZXJQYXRoc01hcCB7XG4gIGJ1aWxkZXJzOiB7IFtrOiBzdHJpbmddOiBCdWlsZGVyUGF0aHMgfTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCdWlsZGVyUGF0aHMge1xuICBjbGFzczogUGF0aDtcbiAgc2NoZW1hOiBQYXRoO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJ1aWxkZXJEZXNjcmlwdGlvbiB7XG4gIG5hbWU6IHN0cmluZztcbiAgc2NoZW1hOiBKc29uT2JqZWN0O1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJ1aWxkZXJDb25zdHJ1Y3RvcjxPcHRpb25zVD4ge1xuICBuZXcoY29udGV4dDogQnVpbGRlckNvbnRleHQpOiBCdWlsZGVyPE9wdGlvbnNUPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVCA9IHt9PiB7XG4gIHJvb3Q6IFBhdGg7XG4gIHNvdXJjZVJvb3Q/OiBQYXRoO1xuICBwcm9qZWN0VHlwZTogc3RyaW5nO1xuICBidWlsZGVyOiBzdHJpbmc7XG4gIG9wdGlvbnM6IE9wdGlvbnNUO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRhcmdldFNwZWNpZmllcjxPcHRpb25zVCA9IHt9PiB7XG4gIHByb2plY3Q6IHN0cmluZztcbiAgdGFyZ2V0OiBzdHJpbmc7XG4gIGNvbmZpZ3VyYXRpb24/OiBzdHJpbmc7XG4gIG92ZXJyaWRlcz86IFBhcnRpYWw8T3B0aW9uc1Q+O1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIFRhcmdldE1hcCB7XG4gIFtrOiBzdHJpbmddOiBUYXJnZXQ7XG59XG5cbmV4cG9ydCBkZWNsYXJlIHR5cGUgVGFyZ2V0T3B0aW9uczxUID0gSnNvbk9iamVjdD4gPSBUO1xuZXhwb3J0IGRlY2xhcmUgdHlwZSBUYXJnZXRDb25maWd1cmF0aW9uPFQgPSBKc29uT2JqZWN0PiA9IFBhcnRpYWw8VD47XG5cbmV4cG9ydCBpbnRlcmZhY2UgVGFyZ2V0PFQgPSBKc29uT2JqZWN0PiB7XG4gIGJ1aWxkZXI6IHN0cmluZztcbiAgb3B0aW9uczogVGFyZ2V0T3B0aW9uczxUPjtcbiAgY29uZmlndXJhdGlvbnM/OiB7IFtrOiBzdHJpbmddOiBUYXJnZXRDb25maWd1cmF0aW9uPFQ+IH07XG59XG5cbmV4cG9ydCBjbGFzcyBBcmNoaXRlY3Qge1xuICBwcml2YXRlIHJlYWRvbmx5IF90YXJnZXRzU2NoZW1hUGF0aCA9IGpvaW4obm9ybWFsaXplKF9fZGlybmFtZSksICd0YXJnZXRzLXNjaGVtYS5qc29uJyk7XG4gIHByaXZhdGUgcmVhZG9ubHkgX2J1aWxkZXJzU2NoZW1hUGF0aCA9IGpvaW4obm9ybWFsaXplKF9fZGlybmFtZSksICdidWlsZGVycy1zY2hlbWEuanNvbicpO1xuICBwcml2YXRlIF90YXJnZXRzU2NoZW1hOiBKc29uT2JqZWN0O1xuICBwcml2YXRlIF9idWlsZGVyc1NjaGVtYTogSnNvbk9iamVjdDtcbiAgcHJpdmF0ZSBfYXJjaGl0ZWN0U2NoZW1hc0xvYWRlZCA9IGZhbHNlO1xuICBwcml2YXRlIF90YXJnZXRNYXBNYXAgPSBuZXcgTWFwPHN0cmluZywgVGFyZ2V0TWFwPigpO1xuICBwcml2YXRlIF9idWlsZGVyUGF0aHNNYXAgPSBuZXcgTWFwPHN0cmluZywgQnVpbGRlclBhdGhzPigpO1xuICBwcml2YXRlIF9idWlsZGVyRGVzY3JpcHRpb25NYXAgPSBuZXcgTWFwPHN0cmluZywgQnVpbGRlckRlc2NyaXB0aW9uPigpO1xuICBwcml2YXRlIF9idWlsZGVyQ29uc3RydWN0b3JNYXAgPSBuZXcgTWFwPHN0cmluZywgQnVpbGRlckNvbnN0cnVjdG9yPHt9Pj4oKTtcblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIF93b3Jrc3BhY2U6IGV4cGVyaW1lbnRhbC53b3Jrc3BhY2UuV29ya3NwYWNlKSB7IH1cblxuICBsb2FkQXJjaGl0ZWN0KCkge1xuICAgIGlmICh0aGlzLl9hcmNoaXRlY3RTY2hlbWFzTG9hZGVkKSB7XG4gICAgICByZXR1cm4gb2YodGhpcyk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHJldHVybiBmb3JrSm9pbihcbiAgICAgICAgdGhpcy5fbG9hZEpzb25GaWxlKHRoaXMuX3RhcmdldHNTY2hlbWFQYXRoKSxcbiAgICAgICAgdGhpcy5fbG9hZEpzb25GaWxlKHRoaXMuX2J1aWxkZXJzU2NoZW1hUGF0aCksXG4gICAgICApLnBpcGUoXG4gICAgICAgIGNvbmNhdE1hcCgoW3RhcmdldHNTY2hlbWEsIGJ1aWxkZXJzU2NoZW1hXSkgPT4ge1xuICAgICAgICAgIHRoaXMuX3RhcmdldHNTY2hlbWEgPSB0YXJnZXRzU2NoZW1hO1xuICAgICAgICAgIHRoaXMuX2J1aWxkZXJzU2NoZW1hID0gYnVpbGRlcnNTY2hlbWE7XG4gICAgICAgICAgdGhpcy5fYXJjaGl0ZWN0U2NoZW1hc0xvYWRlZCA9IHRydWU7XG5cbiAgICAgICAgICAvLyBWYWxpZGF0ZSBhbmQgY2FjaGUgYWxsIHByb2plY3QgdGFyZ2V0IG1hcHMuXG4gICAgICAgICAgcmV0dXJuIGZvcmtKb2luKFxuICAgICAgICAgICAgLi4udGhpcy5fd29ya3NwYWNlLmxpc3RQcm9qZWN0TmFtZXMoKS5tYXAocHJvamVjdE5hbWUgPT4ge1xuICAgICAgICAgICAgICBjb25zdCB1bnZhbGlkYXRlZFRhcmdldE1hcCA9IHRoaXMuX3dvcmtzcGFjZS5nZXRQcm9qZWN0VGFyZ2V0cyhwcm9qZWN0TmFtZSk7XG5cbiAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dvcmtzcGFjZS52YWxpZGF0ZUFnYWluc3RTY2hlbWE8VGFyZ2V0TWFwPihcbiAgICAgICAgICAgICAgICB1bnZhbGlkYXRlZFRhcmdldE1hcCwgdGhpcy5fdGFyZ2V0c1NjaGVtYSkucGlwZShcbiAgICAgICAgICAgICAgICAgIHRhcCh0YXJnZXRNYXAgPT4gdGhpcy5fdGFyZ2V0TWFwTWFwLnNldChwcm9qZWN0TmFtZSwgdGFyZ2V0TWFwKSksXG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KSxcbiAgICAgICAgICApO1xuICAgICAgICB9KSxcbiAgICAgICAgbWFwKCgpID0+IHRoaXMpLFxuICAgICAgKTtcbiAgICB9XG4gIH1cblxuICBsaXN0UHJvamVjdFRhcmdldHMocHJvamVjdE5hbWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gT2JqZWN0LmtleXModGhpcy5fZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZSkpO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZTogc3RyaW5nKTogVGFyZ2V0TWFwIHtcbiAgICBpZiAoIXRoaXMuX3RhcmdldE1hcE1hcC5oYXMocHJvamVjdE5hbWUpKSB7XG4gICAgICB0aHJvdyBuZXcgUHJvamVjdE5vdEZvdW5kRXhjZXB0aW9uKHByb2plY3ROYW1lKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fdGFyZ2V0TWFwTWFwLmdldChwcm9qZWN0TmFtZSkgYXMgVGFyZ2V0TWFwO1xuICB9XG5cbiAgcHJpdmF0ZSBfZ2V0UHJvamVjdFRhcmdldDxUID0ge30+KHByb2plY3ROYW1lOiBzdHJpbmcsIHRhcmdldE5hbWU6IHN0cmluZyk6IFRhcmdldDxUPiB7XG4gICAgY29uc3QgdGFyZ2V0TWFwID0gdGhpcy5fZ2V0UHJvamVjdFRhcmdldE1hcChwcm9qZWN0TmFtZSk7XG5cbiAgICBjb25zdCB0YXJnZXQgPSB0YXJnZXRNYXBbdGFyZ2V0TmFtZV0gYXMge30gYXMgVGFyZ2V0PFQ+O1xuXG4gICAgaWYgKCF0YXJnZXQpIHtcbiAgICAgIHRocm93IG5ldyBUYXJnZXROb3RGb3VuZEV4Y2VwdGlvbihwcm9qZWN0TmFtZSwgdGFyZ2V0TmFtZSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHRhcmdldDtcbiAgfVxuXG4gIGdldEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUPih0YXJnZXRTcGVjOiBUYXJnZXRTcGVjaWZpZXIpOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4ge1xuICAgIGNvbnN0IHtcbiAgICAgIHByb2plY3Q6IHByb2plY3ROYW1lLFxuICAgICAgdGFyZ2V0OiB0YXJnZXROYW1lLFxuICAgICAgY29uZmlndXJhdGlvbjogY29uZmlndXJhdGlvbk5hbWUsXG4gICAgICBvdmVycmlkZXMsXG4gICAgfSA9IHRhcmdldFNwZWM7XG5cbiAgICBjb25zdCBwcm9qZWN0ID0gdGhpcy5fd29ya3NwYWNlLmdldFByb2plY3QocHJvamVjdE5hbWUpO1xuICAgIGNvbnN0IHRhcmdldCA9IHRoaXMuX2dldFByb2plY3RUYXJnZXQocHJvamVjdE5hbWUsIHRhcmdldE5hbWUpO1xuICAgIGNvbnN0IG9wdGlvbnMgPSB0YXJnZXQub3B0aW9ucztcbiAgICBsZXQgY29uZmlndXJhdGlvbjogVGFyZ2V0Q29uZmlndXJhdGlvbiA9IHt9O1xuXG4gICAgaWYgKGNvbmZpZ3VyYXRpb25OYW1lKSB7XG4gICAgICBpZiAoIXRhcmdldC5jb25maWd1cmF0aW9ucykge1xuICAgICAgICB0aHJvdyBuZXcgQ29uZmlndXJhdGlvbk5vdEZvdW5kRXhjZXB0aW9uKHByb2plY3ROYW1lLCBjb25maWd1cmF0aW9uTmFtZSk7XG4gICAgICB9XG5cbiAgICAgIGNvbmZpZ3VyYXRpb24gPSB0YXJnZXQuY29uZmlndXJhdGlvbnNbY29uZmlndXJhdGlvbk5hbWVdO1xuXG4gICAgICBpZiAoIWNvbmZpZ3VyYXRpb24pIHtcbiAgICAgICAgdGhyb3cgbmV3IENvbmZpZ3VyYXRpb25Ob3RGb3VuZEV4Y2VwdGlvbihwcm9qZWN0TmFtZSwgY29uZmlndXJhdGlvbk5hbWUpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXJDb25maWd1cmF0aW9uOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4gPSB7XG4gICAgICByb290OiBwcm9qZWN0LnJvb3QgYXMgUGF0aCxcbiAgICAgIHNvdXJjZVJvb3Q6IHByb2plY3Quc291cmNlUm9vdCBhcyBQYXRoIHwgdW5kZWZpbmVkLFxuICAgICAgcHJvamVjdFR5cGU6IHByb2plY3QucHJvamVjdFR5cGUsXG4gICAgICBidWlsZGVyOiB0YXJnZXQuYnVpbGRlcixcbiAgICAgIG9wdGlvbnM6IHtcbiAgICAgICAgLi4ub3B0aW9ucyxcbiAgICAgICAgLi4uY29uZmlndXJhdGlvbixcbiAgICAgICAgLi4ub3ZlcnJpZGVzIGFzIHt9LFxuICAgICAgfSBhcyBPcHRpb25zVCxcbiAgICB9O1xuXG4gICAgcmV0dXJuIGJ1aWxkZXJDb25maWd1cmF0aW9uO1xuICB9XG5cbiAgcnVuPE9wdGlvbnNUPihcbiAgICBidWlsZGVyQ29uZmlnOiBCdWlsZGVyQ29uZmlndXJhdGlvbjxPcHRpb25zVD4sXG4gICAgcGFydGlhbENvbnRleHQ6IFBhcnRpYWw8QnVpbGRlckNvbnRleHQ+ID0ge30sXG4gICk6IE9ic2VydmFibGU8QnVpbGRFdmVudD4ge1xuICAgIGNvbnN0IGNvbnRleHQ6IEJ1aWxkZXJDb250ZXh0ID0ge1xuICAgICAgbG9nZ2VyOiBuZXcgbG9nZ2luZy5OdWxsTG9nZ2VyKCksXG4gICAgICBhcmNoaXRlY3Q6IHRoaXMsXG4gICAgICBob3N0OiB0aGlzLl93b3Jrc3BhY2UuaG9zdCxcbiAgICAgIHdvcmtzcGFjZTogdGhpcy5fd29ya3NwYWNlLFxuICAgICAgLi4ucGFydGlhbENvbnRleHQsXG4gICAgfTtcblxuICAgIGxldCBidWlsZGVyRGVzY3JpcHRpb246IEJ1aWxkZXJEZXNjcmlwdGlvbjtcblxuICAgIHJldHVybiB0aGlzLmdldEJ1aWxkZXJEZXNjcmlwdGlvbihidWlsZGVyQ29uZmlnKS5waXBlKFxuICAgICAgdGFwKGRlc2NyaXB0aW9uID0+IGJ1aWxkZXJEZXNjcmlwdGlvbiA9IGRlc2NyaXB0aW9uKSxcbiAgICAgIGNvbmNhdE1hcCgoKSA9PiB0aGlzLnZhbGlkYXRlQnVpbGRlck9wdGlvbnMoYnVpbGRlckNvbmZpZywgYnVpbGRlckRlc2NyaXB0aW9uKSksXG4gICAgICB0YXAodmFsaWRhdGVkQnVpbGRlckNvbmZpZyA9PiBidWlsZGVyQ29uZmlnID0gdmFsaWRhdGVkQnVpbGRlckNvbmZpZyksXG4gICAgICBtYXAoKCkgPT4gdGhpcy5nZXRCdWlsZGVyKGJ1aWxkZXJEZXNjcmlwdGlvbiwgY29udGV4dCkpLFxuICAgICAgY29uY2F0TWFwKGJ1aWxkZXIgPT4gYnVpbGRlci5ydW4oYnVpbGRlckNvbmZpZykpLFxuICAgICk7XG4gIH1cblxuICBnZXRCdWlsZGVyRGVzY3JpcHRpb248T3B0aW9uc1Q+KFxuICAgIGJ1aWxkZXJDb25maWc6IEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUPixcbiAgKTogT2JzZXJ2YWJsZTxCdWlsZGVyRGVzY3JpcHRpb24+IHtcbiAgICAvLyBDaGVjayBjYWNoZSBmb3IgdGhpcyBidWlsZGVyIGRlc2NyaXB0aW9uLlxuICAgIGlmICh0aGlzLl9idWlsZGVyRGVzY3JpcHRpb25NYXAuaGFzKGJ1aWxkZXJDb25maWcuYnVpbGRlcikpIHtcbiAgICAgIHJldHVybiBvZih0aGlzLl9idWlsZGVyRGVzY3JpcHRpb25NYXAuZ2V0KGJ1aWxkZXJDb25maWcuYnVpbGRlcikgYXMgQnVpbGRlckRlc2NyaXB0aW9uKTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IE9ic2VydmFibGUoKG9icykgPT4ge1xuICAgICAgLy8gVE9ETzogdGhpcyBwcm9iYWJseSBuZWVkcyB0byBiZSBtb3JlIGxpa2UgTm9kZU1vZHVsZXNFbmdpbmVIb3N0LlxuICAgICAgY29uc3QgYmFzZWRpciA9IGdldFN5c3RlbVBhdGgodGhpcy5fd29ya3NwYWNlLnJvb3QpO1xuICAgICAgY29uc3QgW3BrZywgYnVpbGRlck5hbWVdID0gYnVpbGRlckNvbmZpZy5idWlsZGVyLnNwbGl0KCc6Jyk7XG4gICAgICBjb25zdCBwa2dKc29uUGF0aCA9IG5vZGVSZXNvbHZlKHBrZywgeyBiYXNlZGlyLCByZXNvbHZlUGFja2FnZUpzb246IHRydWUsIGNoZWNrTG9jYWw6IHRydWUgfSk7XG4gICAgICBsZXQgYnVpbGRlcnNKc29uUGF0aDogUGF0aDtcbiAgICAgIGxldCBidWlsZGVyUGF0aHM6IEJ1aWxkZXJQYXRocztcblxuICAgICAgLy8gUmVhZCB0aGUgYGJ1aWxkZXJzYCBlbnRyeSBvZiBwYWNrYWdlLmpzb24uXG4gICAgICByZXR1cm4gdGhpcy5fbG9hZEpzb25GaWxlKG5vcm1hbGl6ZShwa2dKc29uUGF0aCkpLnBpcGUoXG4gICAgICAgIGNvbmNhdE1hcCgocGtnSnNvbjogSnNvbk9iamVjdCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHBrZ0pzb25CdWlsZGVyc2VudHJ5ID0gcGtnSnNvblsnYnVpbGRlcnMnXSBhcyBzdHJpbmc7XG4gICAgICAgICAgaWYgKCFwa2dKc29uQnVpbGRlcnNlbnRyeSkge1xuICAgICAgICAgICAgcmV0dXJuIHRocm93RXJyb3IobmV3IEJ1aWxkZXJDYW5ub3RCZVJlc29sdmVkRXhjZXB0aW9uKGJ1aWxkZXJDb25maWcuYnVpbGRlcikpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGJ1aWxkZXJzSnNvblBhdGggPSBqb2luKGRpcm5hbWUobm9ybWFsaXplKHBrZ0pzb25QYXRoKSksIHBrZ0pzb25CdWlsZGVyc2VudHJ5KTtcblxuICAgICAgICAgIHJldHVybiB0aGlzLl9sb2FkSnNvbkZpbGUoYnVpbGRlcnNKc29uUGF0aCk7XG4gICAgICAgIH0pLFxuICAgICAgICAvLyBWYWxpZGF0ZSBidWlsZGVycyBqc29uLlxuICAgICAgICBjb25jYXRNYXAoKGJ1aWxkZXJQYXRoc01hcCkgPT4gdGhpcy5fd29ya3NwYWNlLnZhbGlkYXRlQWdhaW5zdFNjaGVtYTxCdWlsZGVyUGF0aHNNYXA+KFxuICAgICAgICAgIGJ1aWxkZXJQYXRoc01hcCwgdGhpcy5fYnVpbGRlcnNTY2hlbWEpKSxcbiAgICAgICAgY29uY2F0TWFwKChidWlsZGVyUGF0aHNNYXApID0+IHtcbiAgICAgICAgICBidWlsZGVyUGF0aHMgPSBidWlsZGVyUGF0aHNNYXAuYnVpbGRlcnNbYnVpbGRlck5hbWVdO1xuXG4gICAgICAgICAgaWYgKCFidWlsZGVyUGF0aHMpIHtcbiAgICAgICAgICAgIHJldHVybiB0aHJvd0Vycm9yKG5ldyBCdWlsZGVyQ2Fubm90QmVSZXNvbHZlZEV4Y2VwdGlvbihidWlsZGVyQ29uZmlnLmJ1aWxkZXIpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBSZXNvbHZlIHBhdGhzIGluIHRoZSBidWlsZGVyIHBhdGhzLlxuICAgICAgICAgIGNvbnN0IGJ1aWxkZXJKc29uRGlyID0gZGlybmFtZShidWlsZGVyc0pzb25QYXRoKTtcbiAgICAgICAgICBidWlsZGVyUGF0aHMuc2NoZW1hID0gam9pbihidWlsZGVySnNvbkRpciwgYnVpbGRlclBhdGhzLnNjaGVtYSk7XG4gICAgICAgICAgYnVpbGRlclBhdGhzLmNsYXNzID0gam9pbihidWlsZGVySnNvbkRpciwgYnVpbGRlclBhdGhzLmNsYXNzKTtcblxuICAgICAgICAgIC8vIFNhdmUgdGhlIGJ1aWxkZXIgcGF0aHMgc28gdGhhdCB3ZSBjYW4gbGF6aWx5IGxvYWQgdGhlIGJ1aWxkZXIuXG4gICAgICAgICAgdGhpcy5fYnVpbGRlclBhdGhzTWFwLnNldChidWlsZGVyQ29uZmlnLmJ1aWxkZXIsIGJ1aWxkZXJQYXRocyk7XG5cbiAgICAgICAgICAvLyBMb2FkIHRoZSBzY2hlbWEuXG4gICAgICAgICAgcmV0dXJuIHRoaXMuX2xvYWRKc29uRmlsZShidWlsZGVyUGF0aHMuc2NoZW1hKTtcbiAgICAgICAgfSksXG4gICAgICAgIG1hcChidWlsZGVyU2NoZW1hID0+IHtcbiAgICAgICAgICBjb25zdCBidWlsZGVyRGVzY3JpcHRpb24gPSB7XG4gICAgICAgICAgICBuYW1lOiBidWlsZGVyQ29uZmlnLmJ1aWxkZXIsXG4gICAgICAgICAgICBzY2hlbWE6IGJ1aWxkZXJTY2hlbWEsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogYnVpbGRlclBhdGhzLmRlc2NyaXB0aW9uLFxuICAgICAgICAgIH07XG5cbiAgICAgICAgICAvLyBTYXZlIHRvIGNhY2hlIGJlZm9yZSByZXR1cm5pbmcuXG4gICAgICAgICAgdGhpcy5fYnVpbGRlckRlc2NyaXB0aW9uTWFwLnNldChidWlsZGVyRGVzY3JpcHRpb24ubmFtZSwgYnVpbGRlckRlc2NyaXB0aW9uKTtcblxuICAgICAgICAgIHJldHVybiBidWlsZGVyRGVzY3JpcHRpb247XG4gICAgICAgIH0pLFxuICAgICAgKS5zdWJzY3JpYmUob2JzKTtcbiAgICB9KTtcbiAgfVxuXG4gIHZhbGlkYXRlQnVpbGRlck9wdGlvbnM8T3B0aW9uc1Q+KFxuICAgIGJ1aWxkZXJDb25maWc6IEJ1aWxkZXJDb25maWd1cmF0aW9uPE9wdGlvbnNUPiwgYnVpbGRlckRlc2NyaXB0aW9uOiBCdWlsZGVyRGVzY3JpcHRpb24sXG4gICk6IE9ic2VydmFibGU8QnVpbGRlckNvbmZpZ3VyYXRpb248T3B0aW9uc1Q+PiB7XG4gICAgcmV0dXJuIHRoaXMuX3dvcmtzcGFjZS52YWxpZGF0ZUFnYWluc3RTY2hlbWE8T3B0aW9uc1Q+KFxuICAgICAgYnVpbGRlckNvbmZpZy5vcHRpb25zLCBidWlsZGVyRGVzY3JpcHRpb24uc2NoZW1hLFxuICAgICkucGlwZShcbiAgICAgIG1hcCh2YWxpZGF0ZWRPcHRpb25zID0+IHtcbiAgICAgICAgYnVpbGRlckNvbmZpZy5vcHRpb25zID0gdmFsaWRhdGVkT3B0aW9ucztcblxuICAgICAgICByZXR1cm4gYnVpbGRlckNvbmZpZztcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cblxuICBnZXRCdWlsZGVyPE9wdGlvbnNUPihcbiAgICBidWlsZGVyRGVzY3JpcHRpb246IEJ1aWxkZXJEZXNjcmlwdGlvbiwgY29udGV4dDogQnVpbGRlckNvbnRleHQsXG4gICk6IEJ1aWxkZXI8T3B0aW9uc1Q+IHtcbiAgICBjb25zdCBuYW1lID0gYnVpbGRlckRlc2NyaXB0aW9uLm5hbWU7XG4gICAgbGV0IGJ1aWxkZXJDb25zdHJ1Y3RvcjogQnVpbGRlckNvbnN0cnVjdG9yPE9wdGlvbnNUPjtcblxuICAgIC8vIENoZWNrIGNhY2hlIGZvciB0aGlzIGJ1aWxkZXIuXG4gICAgaWYgKHRoaXMuX2J1aWxkZXJDb25zdHJ1Y3Rvck1hcC5oYXMobmFtZSkpIHtcbiAgICAgIGJ1aWxkZXJDb25zdHJ1Y3RvciA9IHRoaXMuX2J1aWxkZXJDb25zdHJ1Y3Rvck1hcC5nZXQobmFtZSkgYXMgQnVpbGRlckNvbnN0cnVjdG9yPE9wdGlvbnNUPjtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKCF0aGlzLl9idWlsZGVyUGF0aHNNYXAuaGFzKG5hbWUpKSB7XG4gICAgICAgIHRocm93IG5ldyBCdWlsZGVyTm90Rm91bmRFeGNlcHRpb24obmFtZSk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGJ1aWxkZXJQYXRocyA9IHRoaXMuX2J1aWxkZXJQYXRoc01hcC5nZXQobmFtZSkgYXMgQnVpbGRlclBhdGhzO1xuXG4gICAgICAvLyBUT0RPOiBzdXBwb3J0IG1vcmUgdGhhbiB0aGUgZGVmYXVsdCBleHBvcnQsIG1heWJlIHZpYSBidWlsZGVyI2ltcG9ydC1uYW1lLlxuICAgICAgY29uc3QgYnVpbGRlck1vZHVsZSA9IHJlcXVpcmUoZ2V0U3lzdGVtUGF0aChidWlsZGVyUGF0aHMuY2xhc3MpKTtcbiAgICAgIGJ1aWxkZXJDb25zdHJ1Y3RvciA9IGJ1aWxkZXJNb2R1bGVbJ2RlZmF1bHQnXSBhcyBCdWlsZGVyQ29uc3RydWN0b3I8T3B0aW9uc1Q+O1xuXG4gICAgICAvLyBTYXZlIGJ1aWxkZXIgdG8gY2FjaGUgYmVmb3JlIHJldHVybmluZy5cbiAgICAgIHRoaXMuX2J1aWxkZXJDb25zdHJ1Y3Rvck1hcC5zZXQoYnVpbGRlckRlc2NyaXB0aW9uLm5hbWUsIGJ1aWxkZXJDb25zdHJ1Y3Rvcik7XG4gICAgfVxuXG4gICAgY29uc3QgYnVpbGRlciA9IG5ldyBidWlsZGVyQ29uc3RydWN0b3IoY29udGV4dCk7XG5cbiAgICByZXR1cm4gYnVpbGRlcjtcbiAgfVxuXG4gIHByaXZhdGUgX2xvYWRKc29uRmlsZShwYXRoOiBQYXRoKTogT2JzZXJ2YWJsZTxKc29uT2JqZWN0PiB7XG4gICAgcmV0dXJuIHRoaXMuX3dvcmtzcGFjZS5ob3N0LnJlYWQobm9ybWFsaXplKHBhdGgpKS5waXBlKFxuICAgICAgbWFwKGJ1ZmZlciA9PiB2aXJ0dWFsRnMuZmlsZUJ1ZmZlclRvU3RyaW5nKGJ1ZmZlcikpLFxuICAgICAgbWFwKHN0ciA9PiBwYXJzZUpzb24oc3RyLCBKc29uUGFyc2VNb2RlLkxvb3NlKSBhcyB7fSBhcyBKc29uT2JqZWN0KSxcbiAgICApO1xuICB9XG59XG4iXX0=