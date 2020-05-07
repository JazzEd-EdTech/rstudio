/*
 * yaml_metadata.ts
 *
 * Copyright (C) 2019-20 by RStudio, PBC
 *
 * Unless you have received this program directly from RStudio pursuant
 * to the terms of a commercial license agreement with RStudio, then
 * this program is licensed to you under the terms of version 3 of the
 * GNU Affero General Public License. This program is distributed WITHOUT
 * ANY EXPRESS OR IMPLIED WARRANTY, INCLUDING THOSE OF NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE. Please refer to the
 * AGPL (http://www.gnu.org/licenses/agpl-3.0.txt) for more details.
 *
 */

import { Node as ProsemirrorNode, Schema } from 'prosemirror-model';
import { EditorState, Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { setTextSelection } from 'prosemirror-utils';

import { Extension } from '../../api/extension';
import { PandocOutput, PandocTokenType, ProsemirrorWriter, PandocBlockCapsule, PandocToken, kEncodedBlockCapsuleRegEx, parsePandocBlockCapsule } from '../../api/pandoc';
import { EditorUI } from '../../api/ui';
import { ProsemirrorCommand, EditorCommandId } from '../../api/command';
import { canInsertNode } from '../../api/node';
import { codeNodeSpec } from '../../api/code';
import { selectionIsBodyTopLevel } from '../../api/selection';
import { uuidv4 } from '../../api/util';

import { yamlMetadataTitlePlugin } from './yaml_metadata-title';

const kYamlMetadataCapsuleType = 'E1819605-0ACD-4FAE-8B99-9C1B7BD7C0F1'.toLowerCase();

const extension: Extension = {
  nodes: [
    {
      name: 'yaml_metadata',

      spec: {
        ...codeNodeSpec(),
        attrs: {
          navigation_id: { default: null },
        },
        parseDOM: [
          {
            tag: "div[class*='yaml-block']",
            preserveWhitespace: 'full',
          },
        ],
        toDOM(node: ProsemirrorNode) {
          return ['div', { class: 'yaml-block pm-code-block' }, 0];
        },
      },

      code_view: {
        lang: () => 'yaml-frontmatter',
        classes: ['pm-metadata-background-color', 'pm-yaml-metadata-block'],
      },

      pandoc: {
       
        blockCapsuleFilter: {
          type: kYamlMetadataCapsuleType,
          match: /^([\t >]*)(---[ \t]*\n[\W\w]*?(?:\n---|\n\.\.\.))([ \t]*)$/gm,
          enclose: (capsuleText: string) => 
            capsuleText + '\n'
          ,

          handleText: (text: string) : string => {
            kEncodedBlockCapsuleRegEx.lastIndex = 0;
            // TODO: strip off the newline
            return text.replace(kEncodedBlockCapsuleRegEx, (match, p1) => {
              const capsuleText = p1;
              const capsule = parsePandocBlockCapsule(capsuleText);
              if (capsule.type === kYamlMetadataCapsuleType) {
                return capsule.source;
              } else {
                return match;
              }
            });
          },

          handleToken: (tok: PandocToken) => {
            if (tok.t === PandocTokenType.Para) {
              if (tok.c.length === 1 && tok.c[0].t === PandocTokenType.Str) {
                const text = tok.c[0].c as string;
                kEncodedBlockCapsuleRegEx.lastIndex = 0;
                const match = text.match(kEncodedBlockCapsuleRegEx);
                if (match) {
                  const capsuleRecord = parsePandocBlockCapsule(match[0]);
                  if (capsuleRecord.type === kYamlMetadataCapsuleType) {
                    return match[0];
                  }
                }
              }
            }
            return null;
          },

          writeNode: (schema: Schema, writer: ProsemirrorWriter, capsule: PandocBlockCapsule) => {
            writer.openNode(schema.nodes.yaml_metadata, { navigation_id: uuidv4() });
            writer.writeText(capsule.source);
            writer.closeNode();
          }
        },
        
        writer: (output: PandocOutput, node: ProsemirrorNode) => {
          output.writeToken(PandocTokenType.Para, () => {
            output.writeRawMarkdown(node.content);
          });
        },
      },
    },
  ],

  commands: (_schema: Schema, ui: EditorUI) => {
    return [new YamlMetadataCommand()];
  },

  plugins: () => [yamlMetadataTitlePlugin()],
};

class YamlMetadataCommand extends ProsemirrorCommand {
  constructor() {
    super(
      EditorCommandId.YamlMetadata,
      [],
      (state: EditorState, dispatch?: (tr: Transaction) => void, view?: EditorView) => {
        const schema = state.schema;

        if (!canInsertNode(state, schema.nodes.yaml_metadata)) {
          return false;
        }

        // only allow inserting at the top level
        if (!selectionIsBodyTopLevel(state.selection)) {
          return false;
        }

        // create yaml metadata text
        if (dispatch) {
          const tr = state.tr;

          const kYamlLeading = '---\n';
          const kYamlTrailing = '\n---';
          const yamlText = schema.text(kYamlLeading + kYamlTrailing);
          const yamlNode = schema.nodes.yaml_metadata.create({}, yamlText);
          tr.replaceSelectionWith(yamlNode);
          setTextSelection(tr.selection.from - kYamlTrailing.length - 2)(tr);
          dispatch(tr);
        }

        return true;
      },
    );
  }
}

export default extension;
