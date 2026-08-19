"""
eligibility_checker.py — BhashaBridge Layer-4 Eligibility & Action Guidance
=============================================================================

This module provides deterministic, rule-based eligibility evaluation and
action guidance (checklists + steps) directly from Layer 2 structured data.

Core Principles:
----------------
1. Granular Per-Criterion Evaluation:
   Never returns a blanket yes/no. Evaluates each rule/criterion independently
   against user profile inputs (age, occupation, income, location, land, gender).
   Status per criterion:
     - "matched"     (🟢 Criteria satisfied by profile)
     - "possible"    (🟡 Insufficient profile info — needs verification)
     - "not_matched" (🔴 Criteria conflict / not met)

2. Direct Action Guidance Reuse:
   Exposes documents_required as an interactive checklist and application_process
   as ordered numbered steps without calling the LLM again.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any, Optional


@dataclass
class CriterionResult:
    criterion: str
    status: str              # "matched" | "possible" | "not_matched"
    status_label: str        # "Matched" | "Needs Verification" | "Criteria Not Met"
    reason: str
    icon: str


def split_eligibility_criteria(eligibility_text: str) -> list[str]:
    """
    Splits eligibility text into discrete, independent criteria statements.
    Strips bullet points, numbers, and multiple newlines.
    """
    if not eligibility_text or not eligibility_text.strip():
        return ["General eligibility rules apply as per official guidelines."]

    # Split by bullets, newlines, or sentence boundaries (. followed by space/caps)
    lines = re.split(r"(?:[\n•\*\r]|\.\s+(?=[A-Z]))", eligibility_text)
    criteria = []

    for line in lines:
        cleaned = re.sub(r"^\s*[\d\-\*\•\)\.]+\s*", "", line).strip()
        if len(cleaned) >= 10 and not cleaned.lower().startswith("this information"):
            criteria.append(cleaned)

    if not criteria:
        criteria = [eligibility_text.strip()]

    return criteria


def evaluate_criterion(criterion: str, profile: dict) -> CriterionResult:
    """
    Rule-based evaluation of a single criterion against user profile.

    Profile fields supported:
      - age (int)
      - income (int / float / str)
      - occupation (str e.g. "farmer", "student", "worker", "artisan")
      - location (str e.g. "rural", "urban")
      - gender (str e.g. "female", "male")
      - land_owner (bool / str)
      - bpl (bool / str)
    """
    crit_lower = criterion.lower()
    
    # Extract profile attributes if present
    user_age        = profile.get("age")
    user_income     = profile.get("income")
    user_occ        = str(profile.get("occupation", "")).lower()
    user_location   = str(profile.get("location", "")).lower()
    user_gender     = str(profile.get("gender", "")).lower()
    user_land       = profile.get("land_owner")
    user_bpl        = profile.get("bpl")

    # Rule 1: Income Cap Check
    income_match = re.search(r"income\s*(?:below|under|less than|cap of|limit of)?\s*(?:rs\.?|₹)?\s*([\d,]+)", crit_lower)
    if income_match and user_income is not None:
        try:
            cap = int(income_match.group(1).replace(",", ""))
            u_inc = float(user_income)
            if u_inc <= cap:
                return CriterionResult(
                    criterion=criterion,
                    status="matched",
                    status_label="Matched",
                    reason=f"Your stated income (₹{int(u_inc):,}) is within the cap of ₹{cap:,}.",
                    icon="🟢"
                )
            else:
                return CriterionResult(
                    criterion=criterion,
                    status="not_matched",
                    status_label="Criteria Not Met",
                    reason=f"Your stated income (₹{int(u_inc):,}) exceeds the ceiling of ₹{cap:,}.",
                    icon="🔴"
                )
        except (ValueError, TypeError):
            pass

    # Rule 2: Age Range Check
    age_range = re.search(r"(?:between|age of)\s*(\d+)\s*(?:and|to|-)\s*(\d+)", crit_lower)
    if age_range and user_age is not None:
        try:
            min_age, max_age = int(age_range.group(1)), int(age_range.group(2))
            u_age = int(user_age)
            if min_age <= u_age <= max_age:
                return CriterionResult(
                    criterion=criterion,
                    status="matched",
                    status_label="Matched",
                    reason=f"Your age ({u_age} yrs) is within the required range of {min_age}-{max_age} yrs.",
                    icon="🟢"
                )
            else:
                return CriterionResult(
                    criterion=criterion,
                    status="not_matched",
                    status_label="Criteria Not Met",
                    reason=f"Your age ({u_age} yrs) is outside the required range of {min_age}-{max_age} yrs.",
                    icon="🔴"
                )
        except (ValueError, TypeError):
            pass

    # Rule 3: Minimum Age Check
    min_age_match = re.search(r"(?:above|at least|minimum|older than)\s*(\d+)\s*(?:years|yrs)", crit_lower)
    if min_age_match and user_age is not None:
        try:
            min_age = int(min_age_match.group(1))
            u_age = int(user_age)
            if u_age >= min_age:
                return CriterionResult(
                    criterion=criterion,
                    status="matched",
                    status_label="Matched",
                    reason=f"Your age ({u_age} yrs) satisfies the minimum age of {min_age} yrs.",
                    icon="🟢"
                )
            else:
                return CriterionResult(
                    criterion=criterion,
                    status="not_matched",
                    status_label="Criteria Not Met",
                    reason=f"Your age ({u_age} yrs) is below the minimum age of {min_age} yrs.",
                    icon="🔴"
                )
        except (ValueError, TypeError):
            pass

    # Rule 4: Occupation Match
    occ_keywords = {
        "farmer": ["farmer", "kisan", "cultivator", "agriculture"],
        "student": ["student", "school", "college", "study"],
        "artisan": ["artisan", "craftsman", "carpenter", "blacksmith", "tailor"],
        "vendor": ["vendor", "hawker", "street vendor", "shopkeeper"],
        "worker": ["labor", "laborer", "worker", "unorganized"],
    }
    for occ_key, keywords in occ_keywords.items():
        if any(kw in crit_lower for kw in keywords):
            if user_occ:
                if any(kw in user_occ for kw in keywords) or user_occ == occ_key:
                    return CriterionResult(
                        criterion=criterion,
                        status="matched",
                        status_label="Matched",
                        reason=f"Your occupation ({user_occ.title()}) matches the requirement for {occ_key}s.",
                        icon="🟢"
                    )
                else:
                    return CriterionResult(
                        criterion=criterion,
                        status="possible",
                        status_label="Needs Verification",
                        reason=f"Scheme specifies {occ_key}s; verify if your work qualifies.",
                        icon="🟡"
                    )

    # Rule 5: Gender Match
    if "women" in crit_lower or "female" in crit_lower or "girl" in crit_lower:
        if user_gender:
            if user_gender in ("female", "woman", "girl"):
                return CriterionResult(
                    criterion=criterion,
                    status="matched",
                    status_label="Matched",
                    reason="Gender criterion satisfied (Female applicant/beneficiary).",
                    icon="🟢"
                )
            elif user_gender in ("male", "man"):
                return CriterionResult(
                    criterion=criterion,
                    status="not_matched",
                    status_label="Criteria Not Met",
                    reason="This specific benefit is designated for female applicants/girl children.",
                    icon="🔴"
                )

    # Rule 6: Landholding Match
    if "land" in crit_lower or "cultivable" in crit_lower:
        if user_land is not None:
            is_owner = str(user_land).lower() in ("true", "yes", "1", "owns land")
            if is_owner:
                return CriterionResult(
                    criterion=criterion,
                    status="matched",
                    status_label="Matched",
                    reason="Land ownership condition satisfied.",
                    icon="🟢"
                )
            else:
                return CriterionResult(
                    criterion=criterion,
                    status="possible",
                    status_label="Needs Verification",
                    reason="Requires cultivable land ownership or tenancy proof.",
                    icon="🟡"
                )

    # Default fallback: Insufficient information in profile to decide (never a blanket yes/no)
    return CriterionResult(
        criterion=criterion,
        status="possible",
        status_label="Needs Verification",
        reason="Check your personal documents to verify this specific requirement.",
        icon="🟡"
    )


def evaluate_eligibility(eligibility_text: str, user_profile: Optional[dict] = None) -> list[dict]:
    """
    Evaluates each criterion independently and returns a structured list.
    """
    profile = user_profile or {}
    criteria_statements = split_eligibility_criteria(eligibility_text)

    results = []
    for stmt in criteria_statements:
        eval_res = evaluate_criterion(stmt, profile)
        results.append(asdict(eval_res))

    return results


# ── Action Guidance Engine ("Act" UI Section) ────────────────────────────────

def build_action_guide(documents_required: str, application_process: str) -> dict:
    """
    Transforms Layer 2 structured outputs into interactive checklists and
    numbered application steps without invoking the LLM again.
    """
    # 1. Documents Checklist
    doc_lines = re.split(r"(?:[\n•\*\r]|\,\s+)", documents_required or "")
    checklist = []
    for idx, line in enumerate(doc_lines, 1):
        cleaned = re.sub(r"^\s*[\d\-\*\•\)\.]+\s*", "", line).strip()
        if len(cleaned) >= 3 and not cleaned.lower().startswith("this information"):
            checklist.append({
                "id": f"doc-{idx}",
                "label": cleaned,
                "required": True,
            })

    if not checklist:
        checklist = [{
            "id": "doc-1",
            "label": "Identity & Address Proof (Aadhaar Card / Voter ID)",
            "required": True
        }]

    # 2. Numbered Application Steps
    step_lines = re.split(r"(?:\n|\d+[\.\)]\s*)", application_process or "")
    steps = []
    step_num = 1
    for line in step_lines:
        cleaned = line.strip()
        if len(cleaned) >= 8 and not cleaned.lower().startswith("this information"):
            steps.append({
                "step_number": step_num,
                "title": f"Step {step_num}",
                "description": cleaned
            })
            step_num += 1

    if not steps:
        steps = [{
            "step_number": 1,
            "title": "Step 1",
            "description": application_process or "Visit the official government portal or local office to apply."
        }]

    return {
        "documents_checklist": checklist,
        "application_steps": steps,
        "total_documents": len(checklist),
        "total_steps": len(steps),
    }
