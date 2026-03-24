// LeetCode #242: Valid Anagram
// Returns true if t is an anagram of s, otherwise false.
function isAnagram(s, t) {
  if (s.length !== t.length) return false;

  const count = new Map();

  for (const ch of s) {
    count.set(ch, (count.get(ch) || 0) + 1);
  }

  for (const ch of t) {
    if (!count.has(ch)) return false;
    const next = count.get(ch) - 1;
    if (next < 0) return false;
    count.set(ch, next);
  }

  return true;
}

// LeetCode #1: Two Sum
// Returns indices of the two numbers such that they add up to target.
function twoSum(nums, target) {
  const seen = new Map(); // value -> index

  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (seen.has(complement)) {
      return [seen.get(complement), i];
    }
    seen.set(nums[i], i);
  }

  return []; // no solution found
}

// LeetCode #121: Best Time to Buy and Sell Stock
// Returns the maximum profit possible from one buy and one sell.
function maxProfit(prices) {
  let minPrice = Infinity;
  let best = 0;

  for (const price of prices) {
    if (price < minPrice) minPrice = price;
    best = Math.max(best, price - minPrice);
  }

  return best;
}

// LeetCode #20: Valid Parentheses
// Returns true if the input string has valid opening/closing bracket order.
function isValidParentheses(s) {
  const stack = [];
  const pairs = {
    ')': '(',
    ']': '[',
    '}': '{',
  };

  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else {
      if (stack.pop() !== pairs[ch]) return false;
    }
  }

  return stack.length === 0;
}

// LeetCode #125: Valid Palindrome
// Returns true if s is a palindrome after removing non-alphanumeric chars and ignoring case.
function isPalindrome(s) {
  let left = 0;
  let right = s.length - 1;

  const isAlphaNum = (ch) => /[a-zA-Z0-9]/.test(ch);

  while (left < right) {
    while (left < right && !isAlphaNum(s[left])) left++;
    while (left < right && !isAlphaNum(s[right])) right--;

    if (s[left].toLowerCase() !== s[right].toLowerCase()) {
      return false;
    }

    left++;
    right--;
  }

  return true;
}

// LeetCode #217: Contains Duplicate
// Returns true if any value appears at least twice in the array.
function containsDuplicate(nums) {
  const seen = new Set();

  for (const num of nums) {
    if (seen.has(num)) return true;
    seen.add(num);
  }

  return false;
}

// Example usage:
console.log(isAnagram('anagram', 'nagaram')); // true
console.log(isAnagram('rat', 'car')); // false

console.log(twoSum([2, 7, 11, 15], 9)); // [0, 1]
console.log(twoSum([3, 2, 4], 6)); // [1, 2]

console.log(maxProfit([7, 1, 5, 3, 6, 4])); // 5
console.log(maxProfit([7, 6, 4, 3, 1])); // 0

console.log(isValidParentheses('()[]{}')); // true
console.log(isValidParentheses('(]')); // false

console.log(isPalindrome('A man, a plan, a canal: Panama')); // true
console.log(isPalindrome('race a car')); // false

console.log(containsDuplicate([1, 2, 3, 1])); // true
console.log(containsDuplicate([1, 2, 3, 4])); // false

// lets add another leetcode program
// Leetcode #3: Longest Substring Without Repeating Characters
// function 