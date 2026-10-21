import { Trash2 } from "lucide-react";

type RuleDraftItemProps = {
  rule: any;
  removeRuleDraft: (id: string) => void;
  changeRuleDraft: (id: string, data: { name?: string; rule?: string }) => void;
};

export const RuleDraftItem = ({
  rule,
  removeRuleDraft,
  changeRuleDraft,
}: RuleDraftItemProps) => (
  <div key={rule.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, alignItems: "start" }}>
    <div style={{ display: "grid", gap: 8 }}>
      <input
        className="input"
        style={{ width: "100%" }}
        value={rule.name}
        onChange={(e) => changeRuleDraft(rule.id, { name: e.target.value })}
        placeholder="Например, Уголь"
        aria-label="Название правила"
        data-testid={`input-rule-name-${rule.id}`}
      />
      <input
        className="input"
        style={{ width: "100%" }}
        value={rule.rule}
        onChange={(e) => changeRuleDraft(rule.id, { rule: e.target.value })}
        placeholder="Описание правила (текст или нормы расхода)"
        aria-label="Описание правила"
        data-testid={`input-rule-text-${rule.id}`}
      />
    </div>
    <button
      className="btn btn-quiet btn-sm btn-danger"
      onClick={() => removeRuleDraft(rule.id)}
      aria-label="Удалить правило"
      title="Удалить правило"
      data-testid={`button-remove-rule-${rule.id}`}
    >
      <Trash2 size={14} />
    </button>
  </div>
);
);