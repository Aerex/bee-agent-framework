/**
 * Copyright 2024 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BaseToolOptions, BaseToolRunOptions, StringToolOutput, Tool } from "@/tools/base.js";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { PromiseClient, createPromiseClient } from "@connectrpc/connect";
import { FrameworkError } from "@/errors.js";
import { z } from "zod";
import { validate } from "@/internals/helpers/general.js";
import { CodeInterpreterService } from "bee-proto/code_interpreter/v1/code_interpreter_service_connect";

export class CustomToolCreateError extends FrameworkError {}
export class CustomToolExecuteError extends FrameworkError {}

const toolOptionsSchema = z
  .object({
    codeInterpreterUrl: z.string().url(),
    sourceCode: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    inputSchema: z.any(),
    executorId: z.string().nullable().optional(),
  })
  .passthrough();

export type CustomToolOptions = z.output<typeof toolOptionsSchema> & BaseToolOptions;

function createCodeInterpreterClient(url: string) {
  return createPromiseClient(
    CodeInterpreterService,
    createGrpcTransport({ baseUrl: url, httpVersion: "2" }),
  );
}

export class CustomTool extends Tool<StringToolOutput, CustomToolOptions> {
  public get name() {
    return this.options.name;
  }
  public get description() {
    return this.options.description;
  }
  public inputSchema() {
    return this.options.inputSchema;
  }

  protected client: PromiseClient<typeof CodeInterpreterService>;

  static {
    this.register();
  }

  public constructor(
    options: CustomToolOptions,
    client?: PromiseClient<typeof CodeInterpreterService>,
  ) {
    validate(options, toolOptionsSchema);
    super(options);
    this.client = client || createCodeInterpreterClient(options.codeInterpreterUrl);
  }

  protected async _run(input: any, options: BaseToolRunOptions) {
    const { response } = await this.client.executeCustomTool(
      {
        executorId: this.options.executorId || "default",
        toolSourceCode: this.options.sourceCode,
        toolInputJson: JSON.stringify(input),
      },
      { signal: options.signal },
    );

    if (response.case === "error") {
      throw new CustomToolExecuteError(response.value.stderr);
    }

    return new StringToolOutput(response.value!.toolOutputJson);
  }

  loadSnapshot(snapshot: ReturnType<typeof this.createSnapshot>): void {
    super.loadSnapshot(snapshot);
    this.client = createCodeInterpreterClient(this.options.codeInterpreterUrl);
  }

  static async fromSourceCode(codeInterpreterUrl: string, sourceCode: string, executorId?: string) {
    const client = createCodeInterpreterClient(codeInterpreterUrl);
    const response = await client.parseCustomTool({ toolSourceCode: sourceCode });

    if (response.response.case === "error") {
      throw new CustomToolCreateError(response.response.value.errorMessages.join("\n"));
    }

    const { toolName, toolDescription, toolInputSchemaJson } = response.response.value!;

    return new CustomTool(
      {
        codeInterpreterUrl,
        sourceCode,
        name: toolName,
        description: toolDescription,
        inputSchema: JSON.parse(toolInputSchemaJson),
        executorId,
      },
      client,
    );
  }
}