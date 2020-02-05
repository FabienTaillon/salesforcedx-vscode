/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  CliCommandExecutor,
  Command,
  CommandExecution,
  CommandOutput,
  SfdxCommandBuilder
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import * as AdmZip from 'adm-zip';
import { SpawnOptions } from 'child_process';
import * as path from 'path';
import { Observable } from 'rxjs/Observable';
import * as shell from 'shelljs';
import * as vscode from 'vscode';
import { channelService } from '../channels';
import { nls } from '../messages';
import { notificationService, ProgressNotification } from '../notifications';
import { taskViewService } from '../statuses';
import { telemetryService } from '../telemetry';
import { getRootWorkspacePath } from '../util';
import {
  CommonDirDirectoryDiffer,
  DirectoryDiffer,
  DirectoryDiffResults
} from './directoryDiffer';

export interface ConflictDetectionConfig {
  usernameOrAlias: string;
  packageDir: string;
  manifest: string;
}

export class ConflictDetector {
  private differ: DirectoryDiffer;
  private static instance: ConflictDetector;

  constructor(differ?: DirectoryDiffer) {
    this.differ = differ || new CommonDirDirectoryDiffer();
  }

  public static getInstance(): ConflictDetector {
    if (!ConflictDetector.instance) {
      ConflictDetector.instance = new ConflictDetector(
        new CommonDirDirectoryDiffer()
      );
    }
    return ConflictDetector.instance;
  }

  private readonly relativeMetdataTempPath = path.join(
    '.sfdx',
    'tools',
    'conflicts'
  );

  private readonly relativePackageXmlPath = path.join(
    this.relativeMetdataTempPath,
    'package.xml'
  );

  private readonly relativeUnpackagedPath = path.join(
    this.relativeMetdataTempPath,
    'unpackaged'
  );

  private readonly relativeConvertedPath = path.join(
    '.sfdx',
    'tools',
    'conflicts',
    'converted'
  );

  public buildRetrieveOrgSourceCommand(data: ConflictDetectionConfig): Command {
    return new SfdxCommandBuilder()
      .withDescription(nls.localize('conflict_detect_retrieve_org_source'))
      .withArg('force:mdapi:retrieve')
      .withFlag('--retrievetargetdir', this.relativeMetdataTempPath)
      .withFlag('--unpackaged', this.relativePackageXmlPath)
      .withFlag('--targetusername', data.usernameOrAlias)
      .withLogName('conflict_detect_retrieve_org_source')
      .build();
  }

  public buildMetadataApiConvertOrgSourceCommand(
    data: ConflictDetectionConfig
  ): Command {
    return new SfdxCommandBuilder()
      .withDescription(nls.localize('conflict_detect_convert_org_source'))
      .withArg('force:mdapi:convert')
      .withFlag('--rootdir', this.relativeUnpackagedPath)
      .withFlag('--outputdir', this.relativeConvertedPath)
      .withLogName('conflict_detect_convert_org_source')
      .build();
  }

  public async checkForConflicts(
    data: ConflictDetectionConfig
  ): Promise<DirectoryDiffResults> {
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;

    const results = await this.checkForConflictsInternal(
      getRootWorkspacePath(),
      data,
      cancellationTokenSource,
      cancellationToken
    );
    return results;
  }

  private async checkForConflictsInternal(
    projectPath: string,
    data: ConflictDetectionConfig,
    cancellationTokenSource: any,
    cancellationToken: any
  ): Promise<DirectoryDiffResults> {
    const projectMetadataTempPath = path.join(
      projectPath,
      this.relativeMetdataTempPath
    );

    // 1: create the shadow directory
    const retrievePackageXmlPath = path.join(
      projectPath,
      this.relativePackageXmlPath
    );

    try {
      shell.mkdir('-p', projectMetadataTempPath);
      shell.cp(data.manifest, retrievePackageXmlPath);
    } catch (error) {
      this.reportError('error_creating_packagexml', error);
      return Promise.reject();
    }

    // 2: retrieve unmanaged org source to the shadow directory
    await this.executeCommand(
      this.buildRetrieveOrgSourceCommand(data),
      projectPath,
      cancellationTokenSource,
      cancellationToken
    );

    // 3: unzip retrieved source
    const unpackagedZipFile = path.join(
      projectMetadataTempPath,
      'unpackaged.zip'
    );

    try {
      const zip = new AdmZip(unpackagedZipFile);
      zip.extractAllTo(projectMetadataTempPath, true);
    } catch (error) {
      this.reportError('error_extracting_org_source', error);
      return Promise.reject();
    }

    // 4: convert org source to decomposed (source) format
    await this.executeCommand(
      this.buildMetadataApiConvertOrgSourceCommand(data),
      projectPath,
      cancellationTokenSource,
      cancellationToken
    );

    // 5: diff project directory (local) and retrieved directory (remote)
    // Assume there are consistent subdirs from each root i.e. 'main/default'
    const localSourcePath: string = path.join(projectPath, data.packageDir);
    const remoteSourcePath: string = path.join(
      projectPath,
      this.relativeConvertedPath
    );
    const diffs = this.differ.diff(localSourcePath, remoteSourcePath);

    // 6: cleanup temp directory
    try {
      shell.rm('-rf', projectMetadataTempPath);
    } catch (error) {
      // Failed cleanup should not terminate the service
      this.reportError('error_cleanup_temp_files', error);
    }

    return diffs;
  }

  public async executeCommand(
    command: Command,
    projectPath: string,
    cancellationTokenSource: vscode.CancellationTokenSource,
    cancellationToken: vscode.CancellationToken
  ): Promise<string> {
    const startTime = process.hrtime();
    const execution = new CliCommandExecutor(
      command,
      { cwd: projectPath, env: { SFDX_JSON_TO_STDOUT: 'true' } },
      true
    ).execute(cancellationToken);

    const result = new CommandOutput().getCmdResult(execution);
    this.attachExecution(execution, cancellationTokenSource, cancellationToken);
    execution.processExitSubject.subscribe(() => {
      telemetryService.sendCommandEvent(execution.command.logName, startTime);
    });
    return result;
  }

  protected attachExecution(
    execution: CommandExecution,
    cancellationTokenSource: vscode.CancellationTokenSource,
    cancellationToken: vscode.CancellationToken
  ) {
    channelService.streamCommandOutput(execution);
    channelService.showChannelOutput();
    notificationService.reportCommandExecutionStatus(
      execution,
      cancellationToken
    );
    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }

  private reportError(messageKey: string, error: Error) {
    console.error(error);
    channelService.appendLine(nls.localize(messageKey, error.toString()));
    notificationService.showErrorMessage(
      nls.localize(messageKey, error.toString())
    );
    telemetryService.sendException(
      'ConflictDetectionException',
      error.toString()
    );
  }
}
