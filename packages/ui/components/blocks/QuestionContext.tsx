import React, { useMemo } from 'react';
import type { Block } from '../../types';
import { computeListIndices, groupBlocks, parseMarkdownToBlocks } from '../../utils/parser';
// BlockRenderer renders QuestionBlock, which renders this: a cycle that only
// meets at render time, after both modules have loaded.
import { BlockRenderer } from '../BlockRenderer';

/**
 * A question card's context, rendered as the document renders markdown: the
 * same block parser and the same block renderers, so a table, a list, a code
 * fence, a quote or an image in the context looks the way it does in the
 * document instead of collapsing into one paragraph.
 *
 * The blocks belong to the card: they carry no `data-block-id` of their own,
 * so a selection or pinpoint inside them resolves to the card (and its
 * `data-question-part="context"` part), never to a block id that also names a
 * real document block. The card sets the scale: muted 13px prose, tight
 * spacing.
 */
export const QuestionContext: React.FC<{
  id: string;
  markdown: string;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  githubRepo?: string;
  repoHost?: string;
}> = ({ id, markdown, ...inlineProps }) => {
  const groups = useMemo((): Array<{ list: Block[]; indices: (number | null)[] } | { block: Block }> => {
    // Ids leave after grouping (grouping keys on them); undefined makes the
    // renderers omit `data-block-id`.
    const anonymous = (block: Block): Block => ({ ...block, id: undefined as unknown as string });
    return groupBlocks(parseMarkdownToBlocks(markdown, { frontmatter: false })).map((group) =>
      group.type === 'list-group'
        ? { list: group.blocks.map(anonymous), indices: computeListIndices(group.blocks) }
        : { block: anonymous(group.block) },
    );
  }, [markdown]);

  return (
    <div
      id={id}
      className={[
        'question-context mt-1 text-[13px] leading-normal text-muted-foreground',
        // The document renderers at the card's scale and tone.
        '[&>*]:my-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        '[&_p]:text-[13px] [&_p]:leading-normal [&_p]:text-muted-foreground',
        '[&_.text-sm]:text-[13px] [&_.text-sm]:leading-normal',
        '[&_[data-question-context-list]_span]:text-muted-foreground',
        '[&_h1]:text-[14px] [&_h2]:text-[14px] [&_h3]:text-[13.5px] [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-3 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1',
      ].join(' ')}
      data-question-part="context"
    >
      {groups.map((group, i) =>
        'list' in group ? (
          <div key={`l-${i}`} data-question-context-list="">
            {group.list.map((block, j) => (
              <BlockRenderer key={j} block={block} orderedIndex={group.indices[j]} {...inlineProps} />
            ))}
          </div>
        ) : (
          <BlockRenderer key={`b-${i}`} block={group.block} {...inlineProps} />
        ),
      )}
    </div>
  );
};
